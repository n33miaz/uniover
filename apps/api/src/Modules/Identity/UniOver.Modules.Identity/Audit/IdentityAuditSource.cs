using System.Globalization;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.SharedKernel.Audit;

namespace UniOver.Modules.Identity.Audit;

/// <summary>
/// Traduz uma linha de <c>login_audit</c> para o formato comum da trilha. A tabela não tem coluna de resultado nem de
/// alvo: o resultado sai do nome do evento e o alvo do <c>detail</c>, que é sempre um código curto escolhido pelo
/// servidor (nunca e-mail digitado, senha, token nem nome de pessoa). O que não tem a forma esperada é devolvido como
/// detalhe, sem tentar adivinhar.
/// </summary>
internal static class IdentityAuditNormalizer
{
    public const string Module = "identity";

    /// <summary>Eventos em que a ação não se completou.</summary>
    public static IReadOnlyList<string> FailureEvents { get; } = [AuditEvents.LoginFailed, AuditEvents.StepUpFailed];

    /// <summary>Eventos em que o sistema recusou por regra (conta bloqueada, refresh reutilizado).</summary>
    public static IReadOnlyList<string> DeniedEvents { get; } = [AuditEvents.LoginLocked, AuditEvents.RefreshReuseDetected];

    /// <summary>Eventos cujo detalhe começa pelo id da conta sobre a qual o administrador agiu (formato <c>N</c>, 32 hexadecimais).</summary>
    public static IReadOnlyList<string> TargetAccountEvents { get; } = [AuditEvents.GuestRevoked, AuditEvents.PermissionsChanged];

    public static AuditOutcome OutcomeOf(string eventName) =>
        FailureEvents.Contains(eventName) ? AuditOutcome.Failure
        : DeniedEvents.Contains(eventName) ? AuditOutcome.Denied
        : AuditOutcome.Success;

    public static AuditRecord Normalize(LoginAuditEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);

        string? target = null;
        Guid? targetUser = null;
        var detail = entry.Detail;

        switch (entry.Event)
        {
            case AuditEvents.GuestInviteCreated:
                // id|perm1,perm2: o id do convite é o alvo; a lista de permissões, o detalhe.
                (target, detail) = SplitFirst(entry.Detail);
                break;

            case AuditEvents.GuestInviteAccepted:
            case AuditEvents.GuestInviteRevoked:
            case AuditEvents.PasskeyRegistered:
            case AuditEvents.PasskeyRenamed:
            case AuditEvents.PasskeyRemoved:
                if (IsId(entry.Detail))
                {
                    (target, detail) = (entry.Detail, null);
                }

                break;

            case AuditEvents.GuestRevoked:
                if (TryAccount(entry.Detail, out var revoked))
                {
                    targetUser = revoked;
                    detail = null;
                }

                break;

            case AuditEvents.PermissionsChanged:
                // id|+entrou,entrou|-saiu: a conta é o alvo e o que entrou e saiu, o detalhe.
                var (account, changes) = SplitFirst(entry.Detail);
                if (TryAccount(account, out var changed))
                {
                    targetUser = changed;
                    detail = changes;
                }

                break;

            case AuditEvents.StepUpSucceeded:
                // O detalhe é o código da ação confirmada (por exemplo, trocar permissões).
                (target, detail) = (entry.Detail, null);
                break;

            case AuditEvents.StepUpFailed:
                // acao|motivo, ou só o motivo quando a ação nem foi identificada.
                if (entry.Detail is { } failure && failure.Contains('|', StringComparison.Ordinal))
                {
                    (target, detail) = SplitFirst(failure);
                }

                break;
        }

        return new AuditRecord(
            entry.Id,
            entry.OccurredAt,
            Module,
            entry.Event,
            entry.UserId,
            target,
            targetUser,
            OutcomeOf(entry.Event),
            string.IsNullOrEmpty(detail) ? null : detail,
            entry.Ip,
            entry.UserAgent);
    }

    /// <summary>Divide no primeiro <c>|</c>: o que vem antes e o resto. Sem barra, tudo é "antes" e o resto fica nulo.</summary>
    private static (string? Head, string? Tail) SplitFirst(string? value)
    {
        if (value is null)
        {
            return (null, null);
        }

        var index = value.IndexOf('|', StringComparison.Ordinal);
        return index < 0 ? (value, null) : (value[..index], value[(index + 1)..]);
    }

    private static bool IsId(string? value) => value is { Length: 32 } && Guid.TryParseExact(value, "N", out _);

    private static bool TryAccount(string? value, out Guid id)
    {
        id = default;
        return IsId(value) && Guid.TryParseExact(value, "N", out id);
    }
}

/// <summary>Lê <c>login_audit</c> como uma fonte da trilha unificada: só leitura, com o papel da aplicação.</summary>
internal sealed class IdentityAuditSource(IdentityDbContext db) : IAuditSource
{
    public AuditSourceInfo Info { get; } = new(
        IdentityAuditNormalizer.Module, AuditRetentionPolicy.SecurityDays, AuditEvents.All);

    public async Task<IReadOnlyList<AuditRecord>> ReadAsync(AuditQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        IQueryable<LoginAuditEntry> rows = db.LoginAudit.AsNoTracking();

        if (query.From is { } from)
        {
            rows = rows.Where(r => r.OccurredAt >= from);
        }

        if (query.To is { } to)
        {
            rows = rows.Where(r => r.OccurredAt < to);
        }

        if (query.Actions is { Count: > 0 } actions)
        {
            var wanted = actions.ToArray();
            rows = rows.Where(r => wanted.Contains(r.Event));
        }

        if (query.Outcome is { } outcome)
        {
            var failures = IdentityAuditNormalizer.FailureEvents.ToArray();
            var denied = IdentityAuditNormalizer.DeniedEvents.ToArray();
            rows = outcome switch
            {
                AuditOutcome.Failure => rows.Where(r => failures.Contains(r.Event)),
                AuditOutcome.Denied => rows.Where(r => denied.Contains(r.Event)),
                _ => rows.Where(r => !failures.Contains(r.Event) && !denied.Contains(r.Event)),
            };
        }

        if (query.PersonId is { } person)
        {
            // A conta que agiu OU a conta sobre a qual o administrador agiu (o id vem no começo do detalhe).
            var prefix = person.ToString("N", CultureInfo.InvariantCulture);
            var aboutAccount = IdentityAuditNormalizer.TargetAccountEvents.ToArray();
            rows = rows.Where(r => r.UserId == person
                || (r.Detail != null && aboutAccount.Contains(r.Event) && r.Detail.StartsWith(prefix)));
        }

        if (query.After is { } cursor)
        {
            var at = cursor.OccurredAt;
            var id = cursor.Id;
            rows = cursor.TieFor(IdentityAuditNormalizer.Module) switch
            {
                AuditTie.SameSource => rows.Where(r => r.OccurredAt < at || (r.OccurredAt == at && r.Id.CompareTo(id) < 0)),
                AuditTie.IncludeSameInstant => rows.Where(r => r.OccurredAt <= at),
                _ => rows.Where(r => r.OccurredAt < at),
            };
        }

        var found = await rows
            .OrderByDescending(r => r.OccurredAt)
            .ThenByDescending(r => r.Id)
            .Take(query.Limit)
            .ToListAsync(cancellationToken);

        return [.. found.Select(IdentityAuditNormalizer.Normalize)];
    }
}
