using AwesomeAssertions;
using Microsoft.Extensions.Options;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Tests.Adapters;

public class TvLinkWatcherTests
{
    private const string Agent = "pc-casa";
    private static readonly Guid TvId = Guid.NewGuid();

    private sealed class Presence : ITvAgentPresence
    {
        public bool Fresh { get; set; } = true;

        public bool IsOnline(string agentId) => true;

        public DateTimeOffset? OfflineSince(string agentId) => null;

        public bool IsOfflineBeyondReconnectGrace(string agentId) => false;

        public bool HasRecentReport(string agentId, TimeSpan within) => Fresh;
    }

    private sealed class Stream : ITvStreamPublisher
    {
        public List<(Guid TvId, TvState State)> Published { get; } = [];

        public Action? OnPublish { get; set; }

        public Task? Pending { get; set; }

        public void PublishState(TvState state) => Published.Add((Guid.Empty, state));

        public void PublishState(Guid tvId, TvState state)
        {
            lock (Published)
            {
                Published.Add((tvId, state));
            }

            OnPublish?.Invoke();
        }

        public void PublishShortcuts(IReadOnlyList<TvShortcut> shortcuts)
        {
        }

        public void PublishWatchdog(TvWatchdogEntry entry)
        {
        }
    }

    private static (TvLinkWatcher Watcher, Presence Presence, Stream Stream) Rig()
    {
        var store = new InMemoryTvStateStore();
        store.Apply(Agent, new TvStateSnapshot(TvStateText.PowerOn, 10, null, TvStateText.ConnectionHot, DateTimeOffset.UtcNow));
        var presence = new Presence();
        var stream = new Stream();
        var watcher = new TvLinkWatcher(store, presence, stream, Options.Create(new TvModuleOptions()));
        watcher.Track(TvId, Agent, TvState.From(store.Last(Agent), agentOnline: true));
        return (watcher, presence, stream);
    }

    [Fact]
    public void ASilentAgent_PastTheStaleWindow_PublishesPcOfflineToThatTv_WithoutAnyRead()
    {
        var (watcher, presence, stream) = Rig();

        watcher.Check();
        stream.Published.Should().BeEmpty("nada mudou");

        presence.Fresh = false;
        watcher.Check();

        var (tvId, state) = stream.Published.Should().ContainSingle().Subject;
        tvId.Should().Be(TvId);
        state.Link!.State.Should().Be(TvLinkText.PcOffline);
    }

    [Fact]
    public void WhenTheAgentSpeaksAgain_WithoutTvState_TheRestoredLinkIsPublished()
    {
        var (watcher, presence, stream) = Rig();
        presence.Fresh = false;
        watcher.Check();

        presence.Fresh = true;
        watcher.Check();

        stream.Published.Select(p => p.State.Link!.State).Should().Equal(TvLinkText.PcOffline, TvLinkText.Ready);
    }

    [Fact]
    public void AnUnchangedLink_IsNotPublishedAgain()
    {
        var (watcher, presence, stream) = Rig();
        presence.Fresh = false;

        watcher.Check();
        watcher.Check();
        watcher.Check();

        stream.Published.Should().ContainSingle();
    }

    [Fact]
    public void AnAgentNeverTracked_IsNotWatched()
    {
        var stream = new Stream();
        var watcher = new TvLinkWatcher(
            new InMemoryTvStateStore(), new Presence { Fresh = false }, stream, Options.Create(new TvModuleOptions()));

        watcher.Check();

        stream.Published.Should().BeEmpty();
    }

    [Fact]
    public void WhenTheTvMovesToAnotherAgent_TheOldAgentIsNoLongerPublishedToIt()
    {
        var (watcher, presence, stream) = Rig();

        watcher.Release(TvId, Agent);
        presence.Fresh = false;
        watcher.Check();

        stream.Published.Should().BeEmpty();
    }

    [Fact]
    public void WhenAnotherAgentReportsForTheTv_TheOldOneStopsBeingWatched()
    {
        var (watcher, presence, stream) = Rig();
        watcher.Track(TvId, "pc-novo", TvState.From(null, agentOnline: true));

        presence.Fresh = false;
        watcher.Check();

        stream.Published.Should().OnlyContain(p => p.State.Link!.State == TvLinkText.PcOffline);
        stream.Published.Should().ContainSingle("só o agente atual da TV é vigiado");
    }

    [Fact]
    public void ReleasingAnAgentNowBoundToAnotherTv_KeepsItWatched()
    {
        var (watcher, presence, stream) = Rig();

        watcher.Release(Guid.NewGuid(), Agent);
        presence.Fresh = false;
        watcher.Check();

        stream.Published.Should().ContainSingle();
    }

    [Fact]
    public async Task ACheckRacingAReport_NeverPublishesItsOlderViewAfterTheReport()
    {
        var store = new InMemoryTvStateStore();
        store.Apply(Agent, new TvStateSnapshot(TvStateText.PowerOn, 10, null, TvStateText.ConnectionHot, DateTimeOffset.UtcNow));
        var presence = new Presence();
        TvLinkWatcher? watcher = null;
        var stream = new Stream();
        var ready = TvState.From(store.Last(Agent), agentOnline: true);
        stream.OnPublish = () =>
        {
            // Um relato chega justo enquanto a passada publica: precisa esperar a passada, e vencer depois.
            stream.Pending = Task.Run(() => watcher!.Publish(TvId, Agent, ready));
            Thread.Sleep(100);
            stream.OnPublish = null;
        };
        watcher = new TvLinkWatcher(store, presence, stream, Options.Create(new TvModuleOptions()));
        watcher.Track(TvId, Agent, ready);

        presence.Fresh = false;
        watcher.Check();
        await stream.Pending!;
        presence.Fresh = true;
        watcher.Check();

        stream.Published.Select(p => p.State.Link!.State).Should().Equal(TvLinkText.PcOffline, TvLinkText.Ready);
    }

    [Fact]
    public void ALinkChangeSeenByARead_IsStillPublishedByTheNextPass()
    {
        var (watcher, presence, stream) = Rig();
        presence.Fresh = false;
        var read = TvState.From(new InMemoryTvStateStore().Last(Agent), agentOnline: true, reportFresh: false);

        watcher.Track(TvId, Agent, read);
        watcher.Check();

        var (tvId, state) = stream.Published.Should().ContainSingle().Subject;
        tvId.Should().Be(TvId);
        state.Link!.State.Should().Be(TvLinkText.PcOffline);
    }

    [Fact]
    public void AnAgentBoundWithTheWatcher_IsPublishedAndWatched()
    {
        var stream = new Stream();
        var presence = new Presence();
        var store = new InMemoryTvStateStore();
        var watcher = new TvLinkWatcher(store, presence, stream, Options.Create(new TvModuleOptions()));
        var handler = new UniOver.Modules.Tv.Features.Config.BindAgentHandler(
            null!, null!, null!, null!, store, presence, stream, null!, TimeProvider.System, watcher: watcher);

        handler.AnnounceNewAgent(TvId, Agent);
        stream.Published.Should().ContainSingle();

        presence.Fresh = false;
        watcher.Check();

        stream.Published.Should().HaveCount(2);
        stream.Published[1].State.Link!.State.Should().Be(TvLinkText.PcOffline);
    }

    [Fact]
    public void AnAgentBoundWithAStaleReport_IsAnnouncedAsPcOffline()
    {
        var stream = new Stream();
        var presence = new Presence { Fresh = false };
        var store = new InMemoryTvStateStore();
        store.Apply(Agent, new TvStateSnapshot(TvStateText.PowerOn, 10, null, TvStateText.ConnectionHot, DateTimeOffset.UtcNow));
        var watcher = new TvLinkWatcher(store, presence, stream, Options.Create(new TvModuleOptions()));
        var handler = new UniOver.Modules.Tv.Features.Config.BindAgentHandler(
            null!, null!, null!, null!, store, presence, stream, null!, TimeProvider.System, watcher: watcher,
            options: Options.Create(new TvModuleOptions()));

        handler.AnnounceNewAgent(TvId, Agent);
        watcher.Check();

        stream.Published.Should().ContainSingle().Which.State.Link!.State.Should().Be(TvLinkText.PcOffline);
    }

    private sealed class Selection(UniOver.Modules.Tv.Features.Selection.TvTarget target)
        : UniOver.Modules.Tv.Features.Selection.ITvCurrentSelection
    {
        public UniOver.Modules.Tv.Features.Selection.TvTarget Current => target;

        public bool TryGet(out UniOver.Modules.Tv.Features.Selection.TvTarget? found)
        {
            found = target;
            return true;
        }

        public void Set(UniOver.Modules.Tv.Features.Selection.TvTarget value)
        {
        }
    }

    [Fact]
    public void ALinkChangePublishedByARead_BecomesTheBaseline_SoTheNextPassDoesNotRepeatIt()
    {
        var store = new InMemoryTvStateStore();
        store.Apply(Agent, new TvStateSnapshot(TvStateText.PowerOn, 10, null, TvStateText.ConnectionHot, DateTimeOffset.UtcNow));
        var presence = new Presence();
        var stream = new Stream();
        var options = Options.Create(new TvModuleOptions());
        var watcher = new TvLinkWatcher(store, presence, stream, options);
        watcher.Track(TvId, Agent, TvState.From(store.Last(Agent), agentOnline: true));
        var target = new UniOver.Modules.Tv.Features.Selection.TvTarget(TvId, Agent, "TV", true);
        var provider = new TvStateProvider(new Selection(target), store, presence, options, watcher);

        presence.Fresh = false;
        provider.Current(target);
        watcher.Check();

        stream.Published.Should().ContainSingle("a leitura já publicou o elo e a passada não repete");
    }
}
