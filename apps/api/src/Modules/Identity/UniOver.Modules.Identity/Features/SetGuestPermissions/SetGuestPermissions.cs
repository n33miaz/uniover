using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Features.ListGuests;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.SetGuestPermissions;

/// <param name="Permissions">A lista COMPLETA desejada: o que não está nela deixa de valer, o que está e faltava passa a valer.</param>
internal sealed record SetGuestPermissionsRequest(IReadOnlyList<string>? Permissions);

internal enum SetGuestPermissionsStatus
{
    Updated,

    /// <summary>Não há convidado com esse id (o id do dono também cai aqui: o dono não tem concessões).</summary>
    NotFound,

    /// <summary>O acesso do convidado foi revogado: não há o que conceder.</summary>
    Revoked,

    /// <summary>Outra mudança de permissão na mesma conta venceu a corrida.</summary>
    Conflict,
}

internal sealed record SetGuestPermissionsResult(SetGuestPermissionsStatus Status, GuestSummary? Guest = null);

internal sealed class SetGuestPermissionsHandler(
    IdentityDbContext db, LoginAuditWriter audit, AccessGrantsService grants, TimeProvider time)
{
    /// <param name="permissions">Já conferidas por <see cref="PermissionRules.Validate"/> (catálogo, módulo, dependência).</param>
    public async Task<SetGuestPermissionsResult> HandleAsync(
        Guid ownerId,
        Guid guestId,
        IReadOnlyList<string> permissions,
        ClientInfo client,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(permissions);
        ArgumentNullException.ThrowIfNull(client);

        var now = time.GetUtcNow();
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);

        // A linha da conta serializa substituições concorrentes da lista completa de concessões.
        // Depois de esperar pela trava, a próxima leitura das concessões vê o commit anterior.
        var account = await db.Users
            .FromSqlInterpolated($"SELECT * FROM identity.users WHERE id = {guestId} AND role = {AccountRoles.Guest} FOR UPDATE")
            .AsNoTracking()
            .SingleOrDefaultAsync(cancellationToken);
        if (account is null)
        {
            return new SetGuestPermissionsResult(SetGuestPermissionsStatus.NotFound);
        }

        if (account.DisabledAt is not null)
        {
            return new SetGuestPermissionsResult(SetGuestPermissionsStatus.Revoked);
        }

        var current = await db.UserGrants.Where(g => g.UserId == guestId).ToListAsync(cancellationToken);
        var wanted = permissions.ToHashSet(StringComparer.Ordinal);
        var removed = current.Where(g => !wanted.Contains(g.Permission)).ToList();
        var added = wanted.Where(p => current.All(g => g.Permission != p)).ToList();

        if (removed.Count > 0 || added.Count > 0)
        {
            db.UserGrants.RemoveRange(removed);
            db.UserGrants.AddRange(added.Select(p => UserGrant.Create(guestId, p, ownerId, now)));

            // O que entrou e o que saiu, sem nome nem e-mail da pessoa: só o id da conta e os identificadores do catálogo.
            audit.Add(ownerId, AuditEvents.PermissionsChanged, client, ChangeAuditDetail(guestId, added, removed.Select(g => g.Permission)));
            try
            {
                await db.SaveChangesAsync(cancellationToken);
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                // Duas edições ao mesmo tempo tentaram conceder a mesma permissão: a segunda desiste e o dono repete.
                return new SetGuestPermissionsResult(SetGuestPermissionsStatus.Conflict);
            }
        }

        await transaction.CommitAsync(cancellationToken);

        // Só depois do commit: nesta instância a mudança vale na hora; em outra, em até o prazo do cache (30 s).
        grants.Invalidate(guestId);

        var summary = new GuestSummary(
            account.Id, account.DisplayName, account.Email, account.CreatedAt, account.DisabledAt, PermissionRules.Effective(wanted));
        return new SetGuestPermissionsResult(SetGuestPermissionsStatus.Updated, summary);
    }

    /// <summary>
    /// <c>id|+entrou,entrou|-saiu</c>. Cabe nos 200 caracteres do detalhe mesmo com o catálogo inteiro (um teste vigia),
    /// então a trilha nunca é cortada em silêncio.
    /// </summary>
    internal static string ChangeAuditDetail(Guid guestId, IEnumerable<string> added, IEnumerable<string> removed) =>
        $"{guestId:N}|+{string.Join(',', added.Order(StringComparer.Ordinal))}|-{string.Join(',', removed.Order(StringComparer.Ordinal))}";
}

internal static class SetGuestPermissionsEndpoint
{
    /// <summary>Só o dono, com a confirmação da passkey: mudar permissões concede ou amplia acesso.</summary>
    public static void MapSetGuestPermissions(this IEndpointRouteBuilder group) =>
        group.MapPut("/guests/{id:guid}/permissions", HandleAsync)
            .RequireAuthorization(StepUp.Policy(StepUpActions.PermissionsChange))
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces<GuestSummary>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        Guid id,
        HttpContext http,
        ICurrentUser current,
        SetGuestPermissionsRequest? request,
        SetGuestPermissionsHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return IdentityProblems.Unauthenticated();
        }

        var permissions = PermissionRules.Validate(request?.Permissions);
        if (!permissions.IsValid)
        {
            return IdentityProblems.InvalidPermissions(permissions.Errors);
        }

        var result = await handler.HandleAsync(userId, id, permissions.Permissions, ClientInfo.From(http), cancellationToken);
        return result.Status switch
        {
            SetGuestPermissionsStatus.Updated => TypedResults.Ok(result.Guest),
            SetGuestPermissionsStatus.Revoked => IdentityProblems.GuestRevoked(),
            SetGuestPermissionsStatus.Conflict => IdentityProblems.PermissionsConflict(),
            _ => TypedResults.NotFound(),
        };
    }
}
