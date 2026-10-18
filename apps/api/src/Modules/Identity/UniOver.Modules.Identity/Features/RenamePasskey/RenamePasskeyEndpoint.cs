using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.RenamePasskey;

internal sealed record RenamePasskeyRequest(string? Name);

internal static class RenamePasskeyEndpoint
{
    public static void MapRenamePasskey(this IEndpointRouteBuilder group) =>
        group.MapPatch("/passkeys/{id:guid}", HandleAsync).RequireAuthorization();

    private static async Task<IResult> HandleAsync(
        Guid id,
        ICurrentUser current,
        RenamePasskeyRequest? request,
        RenamePasskeyHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return IdentityProblems.Unauthenticated();
        }

        var name = PasskeyRules.NormalizeName(request?.Name);
        if (name is null)
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["name"] = [$"Informe um nome de até {PasskeyRules.MaxNameLength} caracteres."],
            });
        }

        var summary = await handler.HandleAsync(userId, id, name, cancellationToken);
        return summary is null ? TypedResults.NotFound() : TypedResults.Ok(summary);
    }
}
