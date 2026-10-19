using UniOver.BuildingBlocks.Web;
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
internal sealed class TvStreamPublisher(SseBroadcaster<object> broadcaster) : ITvStreamPublisher
{
    public void PublishState(TvState state) => broadcaster.Publish(new SseMessage<object>(TvStreamEvents.State, state));

    public void PublishShortcuts(IReadOnlyList<TvShortcut> shortcuts) =>
        broadcaster.Publish(new SseMessage<object>(TvStreamEvents.Shortcuts, shortcuts));

    public void PublishWatchdog(TvWatchdogEntry entry) => broadcaster.Publish(new SseMessage<object>(TvStreamEvents.Watchdog, entry));
}
