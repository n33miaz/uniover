using System.Security.Claims;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Events;

internal sealed class StreamEventsHandler(TvStateProvider provider, ITvShortcutReader shortcuts, ITvCurrentSelection selection, TvStreamPublisher stream)
{
    /// <summary>
    /// Abre o fluxo do usuário. O instantâneo (estado e atalhos) entra na fila antes de qualquer mudança, então a tela
    /// recebe primeiro o que existe agora e depois só as diferenças.
    /// </summary>
    public async Task<SseSubscription<object>> OpenAsync(Guid userId, CancellationToken cancellationToken)
    {
        var state = await provider.CurrentAsync(cancellationToken);
        var list = await shortcuts.ListAsync(selection.Current.Id, cancellationToken);
        return stream.Subscribe(
            selection.Current.Id,
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
        ITvCurrentSelection selection,
        TvSelectionService selections,
        TvStreamPublisher stream,
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

        // O administrador não paga a consulta. Quem não é administrador tem a permissão e a visibilidade da TV escolhida
        // reavaliadas com o fluxo aberto: conta revogada, sem module:tv ou removida da TV fecha o fluxo. A leitura é do
        // banco, nunca do JWT; sem a porta registrada, nega (falha fechada), nunca "sem conferência".
        if (string.Equals(AccountRoles.Of(principal), AccountRoles.Owner, StringComparison.Ordinal))
        {
            return SseResults.Stream(subscription, stream.Options, time, lifetime.ApplicationStopping);
        }

        var grants = services.GetService<IAccessGrants>();
        Guid? tvId = selection.Current.IsPersisted ? selection.Current.Id : null;
        var recheckGate = new SemaphoreSlim(1, 1);
        Func<CancellationToken, Task<bool>> stillAllowed =
            async ct =>
            {
                // O keep-alive e o vigia próprio podem despertar no mesmo instante. Compartilham o DbContext do pedido,
                // que só aceita uma consulta por vez, então a segunda conferência espera a primeira sem deixar passar.
                await recheckGate.WaitAsync(ct);
                try
                {
                    return grants is not null
                        && await grants.HasAsync(userId, AccessPermissions.TvModule, ct)
                        && await selections.ResolveAsync(userId, isOwner: false, tvId, ct) is not null;
                }
                finally
                {
                    recheckGate.Release();
                }
            };

        // Duas conferências com o mesmo critério: no keep-alive do fluxo ocioso (antes de escrever qualquer coisa) e por
        // relógio próprio, para o fluxo movimentado em que o keep-alive nunca chega a disparar.
        return new RecheckedStream<object>(
            SseResults.Stream(subscription, stream.Options, time, stillAllowed, lifetime.ApplicationStopping),
            subscription,
            stillAllowed,
            stream.Options.KeepAlive,
            time);
    }
}
