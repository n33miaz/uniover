using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Persistence;

namespace UniOver.Modules.Tv.Features.RecentCommands;

/// <summary>Uma linha do histórico curto. Não leva conteúdo de texto digitado (a trilha só guarda o tamanho).</summary>
internal sealed record RecentCommand(
    Guid Id,
    string Command,
    string? Detail,
    bool Ok,
    string? ErrorCode,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? LatencyMs,
    DateTimeOffset OccurredAt);

internal sealed class RecentCommandsHandler(TvDbContext db)
{
    public const int DefaultLimit = 20;
    public const int MaxLimit = 100;

    public async Task<IReadOnlyList<RecentCommand>> HandleAsync(int limit, CancellationToken cancellationToken) =>
        await db.CommandAudit.AsNoTracking()
            .OrderByDescending(a => a.OccurredAt)
            .ThenByDescending(a => a.Id)
            .Take(limit)
            .Select(a => new RecentCommand(a.Id, a.Command, a.Detail, a.Ok, a.ErrorCode, a.LatencyMs, a.OccurredAt))
            .ToListAsync(cancellationToken);
}

internal static class RecentCommandsEndpoint
{
    public static void MapRecentCommands(this IEndpointRouteBuilder group) =>
        group.MapGet("/commands/recent", HandleAsync).RequireAuthorization()
            .Produces<IReadOnlyList<RecentCommand>>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized);

    private static async Task<IResult> HandleAsync(
        RecentCommandsHandler handler, CancellationToken cancellationToken, int? limit = null)
    {
        var take = limit ?? RecentCommandsHandler.DefaultLimit;
        if (take is < 1 or > RecentCommandsHandler.MaxLimit)
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["limit"] = [$"O limite deve ficar entre 1 e {RecentCommandsHandler.MaxLimit}."],
            });
        }

        return TypedResults.Ok(await handler.HandleAsync(take, cancellationToken));
    }
}
