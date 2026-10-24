using UniOver.BuildingBlocks.Web;
using Microsoft.Extensions.Options;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>Nomes dos eventos do fluxo SSE da TV.</summary>
internal static class TvStreamEvents
{
    public const string State = "tv.state";
    public const string Shortcuts = "tv.shortcuts";
    public const string Watchdog = "tv.watchdog";
}

/// <summary>
/// Publica no fluxo SSE. O <see cref="SseBroadcaster{T}"/> serializa pelo tipo declarado: com <c>object</c> cada
/// evento sai pelo tipo real do dado (estado, lista de atalhos ou evento do vigia) num broadcaster só.
/// </summary>
internal sealed class TvStreamPublisher(IOptions<TvModuleOptions> options) : ITvStreamPublisher
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, SseBroadcaster<object>> _streams = new();

    public SseStreamOptions Options { get; } = options.Value.Sse;

    public SseSubscription<object> Subscribe(Guid tvId, string userId, Func<IEnumerable<SseMessage<object>>> snapshot) =>
        Stream(tvId).Subscribe(userId, snapshot);

    public void PublishState(TvState state) => PublishState(Guid.Empty, state);

    public void PublishState(Guid tvId, TvState state) => Stream(tvId).Publish(new SseMessage<object>(TvStreamEvents.State, state));

    public void PublishShortcuts(IReadOnlyList<TvShortcut> shortcuts) => PublishShortcuts(Guid.Empty, shortcuts);

    public void PublishShortcuts(Guid tvId, IReadOnlyList<TvShortcut> shortcuts) =>
        Stream(tvId).Publish(new SseMessage<object>(TvStreamEvents.Shortcuts, shortcuts));

    public void PublishWatchdog(TvWatchdogEntry entry) => PublishWatchdog(Guid.Empty, entry);

    public void PublishWatchdog(Guid tvId, TvWatchdogEntry entry) =>
        Stream(tvId).Publish(new SseMessage<object>(TvStreamEvents.Watchdog, entry));

    public void AdoptUnidentifiedStream(Guid tvId)
    {
        if (tvId != Guid.Empty && _streams.TryGetValue(Guid.Empty, out var unidentified))
        {
            // O mesmo fluxo passa a responder pelos dois identificadores: quem já estava inscrito continua recebendo.
            _streams.TryAdd(tvId, unidentified);
        }
    }

    private SseBroadcaster<object> Stream(Guid tvId) => _streams.GetOrAdd(tvId, _ => new SseBroadcaster<object>(Options));
}
