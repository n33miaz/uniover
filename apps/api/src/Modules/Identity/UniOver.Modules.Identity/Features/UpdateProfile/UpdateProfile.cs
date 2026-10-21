using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Features.GetMe;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.UpdateProfile;

/// <param name="DisplayName">O nome que a pessoa escolheu; passa pelas regras de <see cref="DisplayNameRules"/>.</param>
internal sealed record UpdateProfileRequest(string? DisplayName);

internal sealed class UpdateProfileHandler(IdentityDbContext db, LoginAuditWriter audit, GetMeHandler me, TimeProvider time)
{
    /// <summary>Código do campo no detalhe da auditoria: diz QUAL campo mudou, nunca o valor.</summary>
    internal const string DisplayNameField = "display-name";

    /// <param name="displayName">Já normalizado pelas regras (o endpoint mostra o erro; o domínio confere de novo).</param>
    /// <returns>A conta como ficou, ou nulo se ela já não existe.</returns>
    public async Task<MeResponse?> HandleAsync(Guid userId, string displayName, ClientInfo client, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(client);

        // Só a própria linha, pelo id do token: ninguém altera o nome de outra pessoa por esta rota.
        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == userId, cancellationToken);
        if (user is null)
        {
            return null;
        }

        user.SetDisplayName(displayName, time.GetUtcNow());

        // O nome nunca vai para a auditoria (nem para o log): só o código do campo.
        audit.Add(userId, AuditEvents.ProfileUpdated, client, DisplayNameField);
        await db.SaveChangesAsync(cancellationToken);

        return await me.HandleAsync(userId, cancellationToken);
    }
}

internal static class UpdateProfileEndpoint
{
    /// <summary>
    /// A própria pessoa, dono ou convidado ATIVO, muda o próprio nome. Limite por conta (10 por minuto): é uma escrita
    /// barata, mas não precisa de mais que isso.
    /// </summary>
    public static void MapUpdateProfile(this IEndpointRouteBuilder group) =>
        group.MapPatch("/me", HandleAsync)
            .RequireAuthorization(IdentityAuth.ActiveAccountSessionPolicy)
            .RequireRateLimiting(RateLimitPolicies.Profile)
            .Produces<MeResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        ICurrentUser current,
        UpdateProfileRequest? request,
        UpdateProfileHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return IdentityProblems.Unauthenticated();
        }

        var name = DisplayNameRules.Normalize(request?.DisplayName);
        if (name.Value is not { } displayName)
        {
            return IdentityProblems.InvalidDisplayName(name.Error ?? DisplayNameError.Empty);
        }

        var me = await handler.HandleAsync(userId, displayName, ClientInfo.From(http), cancellationToken);
        return me is null ? IdentityProblems.Unauthenticated() : TypedResults.Ok(me);
    }
}
