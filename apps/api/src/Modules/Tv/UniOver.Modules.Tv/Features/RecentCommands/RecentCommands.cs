using System.Security.Claims;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Persistence;

namespace UniOver.Modules.Tv.Features.RecentCommands;

/// <summary>
/// Uma linha do histórico curto. Não leva conteúdo de texto digitado (a trilha só guarda o tamanho).
/// <c>ByMe</c> diz se o comando foi do próprio usuário que consulta: o dono vê o de todos e distingue os dele.
/// </summary>
internal sealed record RecentCommand(
    Guid Id,
    string Command,
    string? Detail,
    bool Ok,
    string? ErrorCode,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? LatencyMs,
    DateTimeOffset OccurredAt,
    bool ByMe);

internal sealed class RecentCommandsHandler(TvDbContext db)
{
    public const int DefaultLimit = 20;
    public const int MaxLimit = 100;

    /// <param name="viewerId">Quem consulta (marca <c>ByMe</c>).</param>
    /// <param name="onlyViewer"><c>true</c> para o convidado: só as ações dele; o dono passa <c>false</c> e vê todas.</param>
    public async Task<IReadOnlyList<RecentCommand>> HandleAsync(
        Guid viewerId, bool onlyViewer, int limit, CancellationToken cancellationToken) =>
        await db.CommandAudit.AsNoTracking()
            .Where(a => !onlyViewer || a.UserId == viewerId)
            .OrderByDescending(a => a.OccurredAt)
            .ThenByDescending(a => a.Id)
            .Take(limit)
            .Select(a => new RecentCommand(
                a.Id, a.Command, a.Detail, a.Ok, a.ErrorCode, a.LatencyMs, a.OccurredAt, a.UserId == viewerId))
            .ToListAsync(cancellationToken);
}

internal static class RecentCommandsEndpoint
{
    public static void MapRecentCommands(this IEndpointRouteBuilder group) =>
        group.MapGet("/commands/recent", HandleAsync).RequireAuthorization(TvAuth.History)
            .Produces<IReadOnlyList<RecentCommand>>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current,
        ClaimsPrincipal principal,
        RecentCommandsHandler handler,
        CancellationToken cancellationToken,
        int? limit = null)
    {
        if (current.UserId is not { } userId)
        {
            return TvProblems.Unauthenticated();
        }

        var take = limit ?? RecentCommandsHandler.DefaultLimit;
        if (take is < 1 or > RecentCommandsHandler.MaxLimit)
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["limit"] = [$"O limite deve ficar entre 1 e {RecentCommandsHandler.MaxLimit}."],
            });
        }

        // Só o dono vê o histórico de todos; qualquer outro papel vê apenas o que ele mesmo mandou.
        var onlyViewer = AccountRoles.Of(principal) != AccountRoles.Owner;
        return TypedResults.Ok(await handler.HandleAsync(userId, onlyViewer, take, cancellationToken));
    }
}
