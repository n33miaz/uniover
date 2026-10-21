using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.CreateGuestInvite;

/// <param name="DisplayName">O nome que o dono dá ao convidado (vira o nome inicial da conta).</param>
/// <param name="Permissions">O que a pessoa poderá fazer. Ausente = o modelo "só controle da TV"; presente, precisa passar nas regras de permissão.</param>
internal sealed record CreateGuestInviteRequest(string? DisplayName, IReadOnlyList<string>? Permissions = null);

/// <param name="Permissions">Já conferidas e normalizadas.</param>
internal sealed record CreateGuestInviteCommand(
    Guid OwnerId, string DisplayName, IReadOnlyList<string> Permissions, ClientInfo Client);

/// <param name="Token">O segredo do link: aparece só aqui, uma vez. O banco guarda apenas o hash dele.</param>
internal sealed record CreateGuestInviteResponse(
    Guid Id, string DisplayName, IReadOnlyList<string> Permissions, string Token, DateTimeOffset ExpiresAt);

internal sealed class CreateGuestInviteHandler(
    IdentityDbContext db,
    LoginAuditWriter audit,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options)
{
    /// <summary>Nulo quando já há convites pendentes demais.</summary>
    public async Task<CreateGuestInviteResponse?> HandleAsync(CreateGuestInviteCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var settings = options.Value;
        var now = time.GetUtcNow();

        var pending = await db.GuestInvites.CountAsync(
            i => i.UsedAt == null && i.RevokedAt == null && i.ExpiresAt > now, cancellationToken);
        if (pending >= settings.MaxPendingGuestInvites)
        {
            return null;
        }

        var (secret, hash) = SecretTokens.Generate();
        var invite = GuestInvite.Create(
            command.OwnerId, command.DisplayName, hash, now, settings.GuestInviteLifetime, command.Permissions);
        db.GuestInvites.Add(invite);

        // Na auditoria vão o id do convite e a lista de permissões (não é dado sensível); o segredo e o nome do convidado ficam de fora.
        audit.Add(command.OwnerId, AuditEvents.GuestInviteCreated, command.Client, InviteAuditDetail(invite));
        await db.SaveChangesAsync(cancellationToken);

        return new CreateGuestInviteResponse(invite.Id, invite.Label, [.. invite.Permissions], secret, invite.ExpiresAt);
    }

    /// <summary>
    /// <c>id|perm1,perm2,...</c>. A coluna de detalhe trunca em 200 caracteres: o id (32) mais o catálogo inteiro cabe com
    /// folga, e um teste vigia isso para uma permissão nova não ser cortada em silêncio.
    /// </summary>
    internal static string InviteAuditDetail(GuestInvite invite) =>
        $"{invite.Id:N}|{string.Join(',', invite.Permissions)}";
}
