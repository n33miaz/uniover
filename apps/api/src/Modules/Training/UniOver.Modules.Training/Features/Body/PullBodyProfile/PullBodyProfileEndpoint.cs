using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Body;
using UniOver.Modules.Training.Features.Body.PullBodyEntries;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Body.PullBodyProfile;

internal sealed record PullBodyProfileQuery(Guid UserId, PullCursor? After);

/// <summary>O mesmo envelope de cursor das outras leituras, com no máximo um item (o perfil é um só por pessoa).</summary>
internal sealed record PullBodyProfileResponse(IReadOnlyList<BodyProfileResponse> Items, string? NextCursor);

internal sealed class PullBodyProfileHandler(TrainingDbContext db)
{
    /// <summary>
    /// O perfil do usuário, se mudou depois do cursor. O cursor é (instante, id do usuário): como a chave natural é o
    /// próprio usuário, ele serve de id. Toda consulta filtra pelo usuário da sessão: o perfil de outra pessoa nunca aparece.
    /// </summary>
    public async Task<PullBodyProfileResponse> HandleAsync(PullBodyProfileQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);

        var userId = query.UserId;
        var rows = db.Set<BodyProfile>().AsNoTracking().Where(p => p.UserId == userId);

        if (query.After is { } after)
        {
            var stamp = after.UpdatedAt;
            var id = after.Id;
            rows = rows.Where(p => p.UpdatedAt > stamp || (p.UpdatedAt == stamp && p.UserId.CompareTo(id) > 0));
        }

        var profile = await rows.SingleOrDefaultAsync(cancellationToken);
        if (profile is null)
        {
            return new PullBodyProfileResponse([], query.After?.Encode());
        }

        return new PullBodyProfileResponse(
            [BodyProfileResponse.From(profile)],
            new PullCursor(profile.UpdatedAt, profile.UserId).Encode());
    }
}

internal static class PullBodyProfileEndpoint
{
    public static void MapPullBodyProfile(this IEndpointRouteBuilder group) =>
        group.MapGet("/body/profile", HandleAsync).RequireAuthorization(TrainingAuth.Module)
            .Produces<PullBodyProfileResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current,
        PullBodyProfileHandler handler,
        string? after,
        int? limit,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return BodyProblems.Unauthenticated();
        }

        // O puxador genérico do aparelho manda `limit` em toda leitura; aqui ele só é conferido (há no máximo um perfil).
        var errors = PullBodyValidator.Validate(after, limit, out var cursor, out _);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        return TypedResults.Ok(await handler.HandleAsync(new PullBodyProfileQuery(userId, cursor), cancellationToken));
    }
}
