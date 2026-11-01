using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Features.Selection;

namespace UniOver.Modules.Tv.Features.Access;

/// <summary>As TVs que uma conta alcança hoje (as ids), pela mesma regra que decide o que ela vê na tela da TV.</summary>
internal sealed record TvAccessPerson(Guid UserId, IReadOnlyList<Guid> TvIds);

internal sealed record TvAccessResponse(IReadOnlyList<TvAccessPerson> Items);

/// <summary>
/// "TVs por pessoa": para cada conta pedida, quais TVs ela vê. A regra de visibilidade (filiação, a TV padrão de quem nunca
/// teve filiação, a retirada que não devolve a padrão) mora em <see cref="TvSelectionService"/>; esta leitura só a repete
/// por conta, para a tela do administrador nunca ter uma segunda cópia dela. É uma visão do administrador: a rota é dele.
/// </summary>
internal sealed class TvAccessHandler(TvSelectionService selection)
{
    /// <summary>Teto de contas por pedido; a casa tem poucas, e cada conta é uma consulta.</summary>
    public const int MaxPeople = 50;

    public async Task<TvAccessResponse> HandleAsync(IReadOnlyList<Guid> userIds, CancellationToken cancellationToken)
    {
        var items = new List<TvAccessPerson>(userIds.Count);
        foreach (var userId in userIds)
        {
            var visible = await selection.ListVisibleAsync(userId, isOwner: false, cancellationToken);
            items.Add(new TvAccessPerson(userId, [.. visible.Select(t => t.Id)]));
        }

        return new TvAccessResponse(items);
    }
}

internal static class TvAccessEndpoint
{
    public static void MapTvAccess(this IEndpointRouteBuilder group) =>
        group.MapGet("/tvs/access", HandleAsync).RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<TvAccessResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static async Task<IResult> HandleAsync(
        [FromQuery(Name = "userId")] Guid[]? userIds, TvAccessHandler handler, CancellationToken cancellationToken)
    {
        var distinct = (userIds ?? []).Distinct().ToList();
        if (distinct.Count > TvAccessHandler.MaxPeople)
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["userId"] = [$"Peça até {TvAccessHandler.MaxPeople} contas por vez."],
            });
        }

        return TypedResults.Ok(await handler.HandleAsync(distinct, cancellationToken));
    }
}
