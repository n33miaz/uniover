using System.Security.Claims;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Events;

internal sealed class StreamEventsHandler(TvStateProvider provider, ITvShortcutReader shortcuts, SseBroadcaster<object> broadcaster)
{
    /// <summary>
    /// Abre o fluxo do usuário. O instantâneo (estado e atalhos) entra na fila antes de qualquer mudança, então a tela
    /// recebe primeiro o que existe agora e depois só as diferenças.
    /// </summary>
    public async Task<SseSubscription<object>> OpenAsync(Guid userId, CancellationToken cancellationToken)
    {
        var state = provider.Current();
        var list = await shortcuts.ListAsync(cancellationToken);
        return broadcaster.Subscribe(
            userId.ToString(),
            () =>
            [
                new SseMessage<object>(TvStreamEvents.State, state),
                new SseMessage<object>(TvStreamEvents.Shortcuts, list),
            ]);
    }
}

internal static class StreamEventsEndpoint
{
    /// <summary>
    /// Fluxo SSE do estado da TV. Só o cookie de bilhete de stream vale (política <c>TvStream</c>: só GET, dono ou convidado): token
    /// na URL nunca é aceito. O servidor encerra o fluxo a cada 10 minutos e a tela reabre.
    /// </summary>
    public static void MapStreamEvents(this IEndpointRouteBuilder group) =>
        group.MapGet("/events", HandleAsync).RequireAuthorization(TvAuth.StreamPolicy)
            .Produces(StatusCodes.Status200OK, contentType: "text/event-stream")
            .ProducesProblem(StatusCodes.Status401Unauthorized);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current,
        ClaimsPrincipal principal,
        IServiceProvider services,
        StreamEventsHandler handler,
        SseBroadcaster<object> broadcaster,
        TimeProvider time,
        IHostApplicationLifetime lifetime,
        CancellationToken cancellationToken)
    {
        // O limite de fluxos é por usuário; a política já garantiu o bilhete válido, então o "sub" existe.
        if (current.UserId is not { } userId)
        {
            return TvProblems.Unauthenticated();
        }

        var subscription = await handler.OpenAsync(userId, cancellationToken);

        // Convidado revogado com o fluxo aberto: a cada keep-alive o acesso é conferido (cache curto) e o fluxo fecha.
        // O dono não paga a consulta.
        Func<CancellationToken, Task<bool>>? stillAllowed = null;
        if (AccountRoles.Of(principal) == AccountRoles.Guest)
        {
            var status = services.GetService<IAccountStatus>();
            stillAllowed = async ct => status is not null && await status.IsActiveAsync(userId, ct);
        }

        return SseResults.Stream(subscription, broadcaster.Options, time, stillAllowed, lifetime.ApplicationStopping);
    }
}
