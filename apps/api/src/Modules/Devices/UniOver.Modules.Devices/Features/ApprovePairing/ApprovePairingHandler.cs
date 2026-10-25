using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Options;
using Npgsql;
using UniOver.BuildingBlocks.Messaging;
using UniOver.Modules.Devices.Contracts.Pairing;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;
using UniOver.Modules.Tv.Contracts;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Features.ApprovePairing;

/// <param name="UserCode">Já normalizado (<see cref="Domain.UserCode.Normalize"/>).</param>
/// <param name="Name">Nome final escolhido pelo dono; nulo mantém o nome que o agente pediu.</param>
/// <param name="TvName">Nome da TV criada junto; nulo usa o nome do computador.</param>
/// <param name="TvMemberIds">Quem vê a TV (vazia: só o administrador). A aprovação sempre cria a TV ligada ao computador.</param>
/// <param name="OwnTvOnly">
/// Aprovação de um convidado para a PRÓPRIA TV: a TV nasce só com ele como membro (a lista recebida é ignorada), nunca vira
/// a padrão e o convidado tem um teto de computadores ativos. O endpoint que a liga já exige a confirmação da senha.
/// </param>
internal sealed record ApprovePairingCommand(
    Guid UserId,
    string UserCode,
    string? Name,
    string? TvName,
    IReadOnlyList<Guid> TvMemberIds,
    ClientInfo Client,
    bool OwnTvOnly = false);

internal sealed record ApprovedAgent(Guid Id, string Slug, string Name, string Platform);

internal enum ApprovalFailure
{
    None,

    /// <summary>O código não existe, venceu ou já foi decidido.</summary>
    NotFound,

    /// <summary>O convidado já tem o máximo de computadores ativos.</summary>
    GuestLimitReached,
}

internal sealed record ApprovalResult(ApprovedAgent? Agent, ApprovalFailure Failure)
{
    public static ApprovalResult NotFound { get; } = new(null, ApprovalFailure.NotFound);

    public static ApprovalResult LimitReached { get; } = new(null, ApprovalFailure.GuestLimitReached);

    public static ApprovalResult Approved(ApprovedAgent agent) => new(agent, ApprovalFailure.None);
}

internal sealed class ApprovePairingHandler(
    DevicesDbContext db,
    IEventBus events,
    IPairedTvRegistrar tvs,
    PairingAuditWriter audit,
    TimeProvider time,
    IOptions<DevicesModuleOptions> options)
{
    private const string UniqueViolation = "23505";
    private const int SlugAttempts = 5;

    /// <summary>Agente criado, ou o motivo de não ter sido (a borda responde 404 genérico quando o código não existe, venceu ou já foi decidido).</summary>
    public async Task<ApprovalResult> HandleAsync(ApprovePairingCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        for (var attempt = 1; ; attempt++)
        {
            var now = time.GetUtcNow();
            var pairing = await db.Pairings.SingleOrDefaultAsync(p => p.UserCode == command.UserCode, cancellationToken);
            if (pairing is null || !pairing.IsOpenAt(now))
            {
                return ApprovalResult.NotFound;
            }

            var name = command.Name ?? pairing.RequestedName;
            var baseSlug = name == pairing.RequestedName ? pairing.RequestedSlug : AgentSlug.Derive(name);
            var slug = await FreeSlugAsync(baseSlug, cancellationToken);

            var agent = Agent.Create(IdGenerator.NewId(), slug, name, pairing.Platform, command.UserId, now);
            pairing.Approve(now, command.UserId, name, agent.Id);
            db.Agents.Add(agent);
            audit.Add(PairingEvents.Approved, command.Client, agentId: agent.Id, pairingId: pairing.Id, userId: command.UserId);

            // Mesma transação do SaveChanges: o agente e o evento saem juntos ou nenhum dos dois sai.
            await events.PublishAsync(new AgentPaired(IdGenerator.NewId(), now, agent.Id, agent.Slug), cancellationToken);

            await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
            try
            {
                if (command.OwnTvOnly && await GuestLimitReachedAsync(command.UserId, cancellationToken))
                {
                    // Nada foi gravado ainda: limpar o contexto e sair desfaz a transação inteira.
                    db.ChangeTracker.Clear();
                    return ApprovalResult.LimitReached;
                }

                // Primeiro grava o lado que pode colidir no slug. Se ele falhar, o contexto da TV ainda não recebeu
                // estado algum e a tentativa seguinte continua limpa; o commit só acontece depois dos dois schemas.
                await db.SaveChangesAsync(cancellationToken);
                await tvs.RegisterAsync(
                    command.OwnTvOnly
                        ? new PairedTvRegistration(agent.Slug, agent.Name, command.TvName, command.UserId, [command.UserId], CanBeDefault: false)
                        : new PairedTvRegistration(agent.Slug, agent.Name, command.TvName, command.UserId, command.TvMemberIds),
                    db.Database.GetDbConnection(),
                    transaction.GetDbTransaction(),
                    cancellationToken);

                await transaction.CommitAsync(cancellationToken);
                return ApprovalResult.Approved(new ApprovedAgent(agent.Id, agent.Slug, agent.Name, agent.Platform));
            }
            catch (DbUpdateConcurrencyException)
            {
                // Outra aprovação (ou recusa) do mesmo código chegou primeiro.
                db.ChangeTracker.Clear();
                return ApprovalResult.NotFound;
            }
            catch (DbUpdateException ex) when (attempt < SlugAttempts && IsUniqueViolation(ex))
            {
                // Outro agente tomou o slug entre a consulta e a gravação: recomeça escolhendo o próximo livre.
                db.ChangeTracker.Clear();
            }
        }
    }

    /// <summary>
    /// O convidado já tem o teto de computadores ativos? Dentro da transação e sob um bloqueio por conta: duas aprovações
    /// simultâneas do mesmo convidado se enfileiram em vez de passarem juntas pelo limite.
    /// </summary>
    private async Task<bool> GuestLimitReachedAsync(Guid userId, CancellationToken cancellationToken)
    {
        var lockKey = $"uniover:pair-own:{userId:N}";
        await db.Database.ExecuteSqlInterpolatedAsync($"select pg_advisory_xact_lock(hashtextextended({lockKey}, 0))", cancellationToken);
        var active = await db.Agents.CountAsync(a => a.PairedBy == userId && a.RevokedAt == null, cancellationToken);
        return active >= options.Value.Pairing.MaxPerGuest;
    }

    /// <summary>O slug pedido se estiver livre; senão o primeiro sufixo livre (<c>-2</c>, <c>-3</c>...).</summary>
    private async Task<string> FreeSlugAsync(string baseSlug, CancellationToken cancellationToken)
    {
        var taken = await db.Agents.AsNoTracking()
            .Where(a => a.Slug.StartsWith(baseSlug))
            .Select(a => a.Slug)
            .ToListAsync(cancellationToken);

        var candidate = baseSlug;
        for (var n = 1; taken.Contains(candidate, StringComparer.Ordinal); n++)
        {
            candidate = AgentSlug.WithSuffix(baseSlug, n + 1);
        }

        return candidate;
    }

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is PostgresException { SqlState: UniqueViolation };
}
