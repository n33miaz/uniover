using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.LaunchShortcut;

internal sealed record LaunchShortcutCommand(TvCommandOrigin Origin, Guid ShortcutId);

/// <summary>Resultado do lançamento: o atalho pode não existir ou estar escondido (nada vai ao agente nesses casos).</summary>
internal sealed record LaunchShortcutResult(bool Found, bool Active, TvSendOutcome? Outcome);

internal sealed class LaunchShortcutHandler(TvDbContext db, TvCommandRunner runner)
{
    public async Task<LaunchShortcutResult> HandleAsync(LaunchShortcutCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var shortcut = await db.Shortcuts.AsNoTracking().SingleOrDefaultAsync(s => s.Id == command.ShortcutId, cancellationToken);
        if (shortcut is null)
        {
            return new LaunchShortcutResult(false, false, null);
        }

        if (!shortcut.IsActive)
        {
            return new LaunchShortcutResult(true, false, null);
        }

        // O pacote vem da lista que o próprio agente mandou, nunca de texto da requisição.
        var outcome = await runner.RunAsync(
            command.Origin, TvCommandNames.AppLaunch, shortcut.Package, TvMessages.LaunchPackage(shortcut.Package),
            waitForReply: true, cancellationToken);
        return new LaunchShortcutResult(true, true, outcome);
    }
}

internal static class LaunchShortcutEndpoint
{
    public static void MapLaunchShortcut(this IEndpointRouteBuilder group) =>
        group.MapPost("/shortcuts/{id:guid}/launch", HandleAsync).RequireAuthorization(TvAuth.ControlPolicy)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<TvCommandOk>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

    private static async Task<IResult> HandleAsync(
        Guid id, ICurrentUser current, HttpContext http, LaunchShortcutHandler handler, CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        var result = await handler.HandleAsync(new LaunchShortcutCommand(origin, id), cancellationToken);
        if (!result.Found)
        {
            return TypedResults.NotFound();
        }

        if (!result.Active)
        {
            return Results.Problem(
                statusCode: StatusCodes.Status409Conflict,
                title: "Este atalho está escondido ou o app não está mais na TV.",
                type: ProblemDetailsExtensions.TypeBase + TvProblems.ShortcutDisabledType);
        }

        return TvProblems.ToResult(result.Outcome!);
    }
}
