using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.CreateGuestInvite;

internal static class CreateGuestInviteEndpoint
{
    /// <summary>Só o dono, com a confirmação da passkey: o link concede acesso a quem o receber.</summary>
    public static void MapCreateGuestInvite(this IEndpointRouteBuilder group) =>
        group.MapPost("/guest-invites", HandleAsync)
            .RequireAuthorization(StepUp.Policy(StepUpActions.GuestInvite))
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces<CreateGuestInviteResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        ICurrentUser current,
        CreateGuestInviteRequest? request,
        CreateGuestInviteHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return IdentityProblems.Unauthenticated();
        }

        var name = DisplayNameRules.Normalize(request?.DisplayName);
        if (name.Value is not { } label)
        {
            return IdentityProblems.InvalidDisplayName(name.Error ?? DisplayNameError.Empty);
        }

        // Sem lista, o convite é o modelo "só controle da TV". Com lista (mesmo vazia), ela passa pelas regras: o
        // padrão nunca preenche o que o dono mandou errado.
        var permissions = PermissionRules.Validate(request?.Permissions ?? PermissionRules.TvControlOnly);
        if (!permissions.IsValid)
        {
            return IdentityProblems.InvalidPermissions(permissions.Errors);
        }

        var result = await handler.HandleAsync(
            new CreateGuestInviteCommand(userId, label, permissions.Permissions, ClientInfo.From(http)), cancellationToken);

        // O segredo só existe nesta resposta: nada de cache em intermediário.
        http.Response.Headers.CacheControl = "no-store";
        return result is null ? IdentityProblems.TooManyInvites() : TypedResults.Ok(result);
    }
}
