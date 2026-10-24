using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.ListShortcuts;

internal sealed class ListShortcutsHandler(ITvShortcutReader reader, ITvCurrentSelection selection)
{
    public Task<IReadOnlyList<TvShortcut>> HandleAsync(CancellationToken cancellationToken) => reader.ListAsync(selection.Current.Id, cancellationToken);
}

internal static class ListShortcutsEndpoint
{
    public static void MapListShortcuts(this IEndpointRouteBuilder group) =>
        group.MapGet("/shortcuts", async (ListShortcutsHandler handler, CancellationToken cancellationToken) =>
            TypedResults.Ok(await handler.HandleAsync(cancellationToken)))
            .RequireAuthorization(TvAuth.Module)
            .Produces<IReadOnlyList<TvShortcut>>()
            .ProducesProblem(StatusCodes.Status401Unauthorized);
}
