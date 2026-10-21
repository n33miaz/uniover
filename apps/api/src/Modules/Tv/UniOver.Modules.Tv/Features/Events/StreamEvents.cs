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
        var state = await provider.CurrentAsync(cancellationToken);
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
    /// Fluxo SSE do estado da TV. Só o cookie de bilhete de stream vale (política <c>TvStream</c>: só GET e a permissão
    /// <c>module:tv</c>): token na URL nunca é aceito. O servidor encerra o fluxo a cada 10 minutos e a tela reabre; quem
    /// não é administrador é reavaliado durante o fluxo e o perde assim que a permissão sai.
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

        // O administrador não paga a consulta. Quem não é administrador tem a permissão da TV reavaliada com o fluxo
        // aberto, pelo mesmo caminho da política da rota (banco com cache curto, nunca o JWT): conta revogada ou sem
        // module:tv fecha o fluxo. Sem a porta registrada, nega (falha fechada), nunca "sem conferência".
        if (string.Equals(AccountRoles.Of(principal), AccountRoles.Owner, StringComparison.Ordinal))
        {
            return SseResults.Stream(subscription, broadcaster.Options, time, lifetime.ApplicationStopping);
        }

        var grants = services.GetService<IAccessGrants>();
        Func<CancellationToken, Task<bool>> stillAllowed =
            async ct => grants is not null && await grants.HasAsync(userId, AccessPermissions.TvModule, ct);

        // Duas conferências com o mesmo critério: no keep-alive do fluxo ocioso (antes de escrever qualquer coisa) e por
        // relógio próprio, para o fluxo movimentado em que o keep-alive nunca chega a disparar.
        return new RecheckedStream<object>(
            SseResults.Stream(subscription, broadcaster.Options, time, stillAllowed, lifetime.ApplicationStopping),
            subscription,
            stillAllowed,
            broadcaster.Options.KeepAlive,
            time);
    }
}
