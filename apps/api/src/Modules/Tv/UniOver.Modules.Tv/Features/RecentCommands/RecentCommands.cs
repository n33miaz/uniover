using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Persistence;

namespace UniOver.Modules.Tv.Features.RecentCommands;

/// <summary>
/// Uma linha do histórico de uma TV. Não leva conteúdo de texto digitado (a trilha só guarda o tamanho). <c>UserId</c> é a
/// conta que mandou (o nome é do Identity: a tela o junta); <c>ByMe</c> diz se foi o próprio administrador que consulta.
/// </summary>
internal sealed record RecentCommand(
    Guid Id,
    Guid UserId,
    string Command,
    string? Detail,
    bool Ok,
    string? ErrorCode,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? LatencyMs,
    DateTimeOffset OccurredAt,
    bool ByMe);

/// <summary>
/// O histórico por TV é só do administrador: quem usa a TV não tem rota, permissão nem texto que diga que ele existe. Por
/// isso a rota é de administrador (nunca de uma permissão da TV) e o resultado sempre mostra as ações de todos.
/// </summary>
internal sealed class RecentCommandsHandler(TvDbContext db, ITvCurrentSelection selection)
{
    public const int DefaultLimit = 20;
    public const int MaxLimit = 100;

    /// <param name="viewerId">Quem consulta (marca <c>ByMe</c>).</param>
    public async Task<IReadOnlyList<RecentCommand>> HandleAsync(
        Guid viewerId, int limit, CancellationToken cancellationToken) =>
        await db.CommandAudit.AsNoTracking()

            // A anotação de teto diário não é um comando: fica só na trilha do administrador.
            .Where(a => a.Command != TvCommandNames.AuditLimit)
            .Where(a => a.TvId == selection.Current.Id)
            .OrderByDescending(a => a.OccurredAt)
            .ThenByDescending(a => a.Id)
            .Take(limit)
            .Select(a => new RecentCommand(
                a.Id, a.UserId, a.Command, a.Detail, a.Ok, a.ErrorCode, a.LatencyMs, a.OccurredAt, a.UserId == viewerId))
            .ToListAsync(cancellationToken);
}

internal static class RecentCommandsEndpoint
{
    public static void MapRecentCommands(this IEndpointRouteBuilder group) =>
        group.MapGet("/commands/recent", HandleAsync).RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<IReadOnlyList<RecentCommand>>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current,
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

        return TypedResults.Ok(await handler.HandleAsync(userId, take, cancellationToken));
    }
}
