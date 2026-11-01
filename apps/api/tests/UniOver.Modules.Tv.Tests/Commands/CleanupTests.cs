using System.Text.Json;
using AwesomeAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Cleanup;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Ports;
using UniOver.Modules.Tv.Tests.Support;

namespace UniOver.Modules.Tv.Tests.Commands;

public class CleanupTests
{
    private static readonly JsonSerializerOptions WebOptions = new(JsonSerializerDefaults.Web);

    private static readonly TvCommandOrigin Origin = new(Guid.NewGuid(), new ClientInfo("203.0.113.1", "teste"));

    private static readonly TvCleanupReport Report = new(6, 214, 596, 382, ["force-stop:com.exemplo.player"]);

    private sealed class RecordingSender(TvSendOutcome outcome) : ITvCommandSender
    {
        public TvMessage? Message { get; private set; }

        public TimeSpan? Timeout { get; private set; }

        public int Requests { get; private set; }

        public Task<TvSendOutcome> RequestAsync(string agentId, TvMessage message, TimeSpan timeout, CancellationToken cancellationToken)
        {
            Requests++;
            Message = message;
            Timeout = timeout;
            return Task.FromResult(outcome);
        }

        public Task<TvSendOutcome> PostAsync(string agentId, TvMessage message, CancellationToken cancellationToken) =>
            Task.FromResult(outcome);
    }

    /// <summary>Como o agente: o relatório do pedido chega antes do resultado do comando.</summary>
    private sealed class ReportingSender(RecordingSender inner, InMemoryTvCleanupReports reports) : ITvCommandSender
    {
        public Task<TvSendOutcome> RequestAsync(string agentId, TvMessage message, TimeSpan timeout, CancellationToken cancellationToken)
        {
            reports.Complete(Guid.Empty, message.Body.GetProperty("requestId").GetGuid(), Report);
            return inner.RequestAsync(agentId, message, timeout, cancellationToken);
        }

        public Task<TvSendOutcome> PostAsync(string agentId, TvMessage message, CancellationToken cancellationToken) =>
            inner.PostAsync(agentId, message, cancellationToken);
    }

    private sealed class NoAudit : ITvCommandAudit
    {
        public List<CommandAuditEntry> Entries { get; } = [];

        public Task RecordAsync(CommandAuditEntry entry, CancellationToken cancellationToken)
        {
            Entries.Add(entry);
            return Task.CompletedTask;
        }
    }

    private sealed class NoStream : ITvStreamPublisher
    {
        public void PublishState(TvState state)
        {
        }

        public void PublishShortcuts(IReadOnlyList<TvShortcut> shortcuts)
        {
        }

        public void PublishWatchdog(TvWatchdogEntry entry)
        {
        }
    }

    private static (CleanupHandler Handler, RecordingSender Sender, NoAudit Audit, InMemoryTvCleanupReports Reports) Build(
        TvSendOutcome outcome, bool agentReports = true, int cleanupTimeoutSeconds = 30)
    {
        var inner = new RecordingSender(outcome);
        var audit = new NoAudit();
        var reports = new InMemoryTvCleanupReports(TimeProvider.System);
        ITvCommandSender sender = agentReports ? new ReportingSender(inner, reports) : inner;
        var options = Options.Create(new TvModuleOptions { CleanupTimeoutSeconds = cleanupTimeoutSeconds });
        var runner = new TvCommandRunner(options, new FixedAgentResolver("pc-casa"), new FakePresence(), sender, new InMemoryTvStateStore(), audit, new NoStream(), TimeProvider.System, NullLogger<TvCommandRunner>.Instance);
        return (new CleanupHandler(runner, reports, options), inner, audit, reports);
    }

    // ---- opções ----

    [Fact]
    public void Options_TheCleanupTimeoutDefaultsTo30Seconds_AndIsLongerThanTheCommandTimeout()
    {
        var options = new TvModuleOptions();

        options.CleanupTimeoutSeconds.Should().Be(30);
        options.CleanupTimeout.Should().Be(TimeSpan.FromSeconds(30));
        options.CleanupTimeout.Should().BeGreaterThan(options.CommandTimeout);
        TvModuleOptions.IsValid(options).Should().BeTrue();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    public void Options_ANonPositiveCleanupTimeoutIsInvalid(int seconds)
    {
        TvModuleOptions.IsValid(new TvModuleOptions { CleanupTimeoutSeconds = seconds }).Should().BeFalse();
    }

    // ---- mensagem ----

    [Fact]
    public void Message_CarriesOnlyTheRequestId()
    {
        var id = Guid.NewGuid();

        var message = TvMessages.Cleanup(id);

        message.Type.Should().Be("tv.cleanup.v1");
        message.Body.GetRawText().Should().Be($"{{\"requestId\":\"{id}\"}}");
    }

    // ---- junção do relatório ----

    [Fact]
    public void Reports_AllowOneCleanupAtATime_AndDisposingFreesTheTurn()
    {
        var reports = new InMemoryTvCleanupReports(TimeProvider.System);

        var first = reports.TryBegin(Guid.Empty);
        first.Should().NotBeNull();
        reports.TryBegin(Guid.Empty).Should().BeNull();

        first!.Dispose();
        using var second = reports.TryBegin(Guid.Empty);
        second.Should().NotBeNull();
        second!.RequestId.Should().NotBe(first.RequestId);
    }

    [Fact]
    public async Task Reports_KeepTheCleanupsOfDifferentTvsSeparate()
    {
        var reports = new InMemoryTvCleanupReports(TimeProvider.System);
        var firstTv = Guid.NewGuid();
        var secondTv = Guid.NewGuid();
        using var first = reports.TryBegin(firstTv)!;
        using var second = reports.TryBegin(secondTv)!;

        reports.Complete(secondTv, second.RequestId, Report);

        (await second.WaitAsync(TimeSpan.FromSeconds(1), CancellationToken.None)).Should().BeSameAs(Report);
        (await first.WaitAsync(TimeSpan.FromMilliseconds(50), CancellationToken.None)).Should().BeNull();
    }

    [Fact]
    public void Reports_DisposingAStaleTicketNeverFreesTheTurnOfANewerOne()
    {
        var reports = new InMemoryTvCleanupReports(TimeProvider.System);
        var first = reports.TryBegin(Guid.Empty)!;
        first.Dispose();
        using var second = reports.TryBegin(Guid.Empty)!;

        first.Dispose();

        reports.TryBegin(Guid.Empty).Should().BeNull("a limpeza nova segue ocupando a vez");
    }

    [Fact]
    public async Task Reports_TheReportReachesTheTicketThatWaitsForItsRequestId()
    {
        var reports = new InMemoryTvCleanupReports(TimeProvider.System);
        using var ticket = reports.TryBegin(Guid.Empty)!;

        reports.Complete(Guid.Empty, ticket.RequestId, Report);

        (await ticket.WaitAsync(TimeSpan.FromSeconds(1), CancellationToken.None)).Should().BeSameAs(Report);
    }

    [Fact]
    public async Task Reports_AReportThatArrivesWhileWaitingWakesTheWait()
    {
        var reports = new InMemoryTvCleanupReports(TimeProvider.System);
        using var ticket = reports.TryBegin(Guid.Empty)!;

        var waiting = ticket.WaitAsync(TimeSpan.FromSeconds(10), CancellationToken.None);
        reports.Complete(Guid.Empty, ticket.RequestId, Report);

        (await waiting.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken)).Should().BeSameAs(Report);
    }

    [Fact]
    public async Task Reports_AReportForAnotherRequestIdIsIgnored_AndTheWaitEndsInNull()
    {
        var reports = new InMemoryTvCleanupReports(TimeProvider.System);
        using var ticket = reports.TryBegin(Guid.Empty)!;

        reports.Complete(Guid.Empty, Guid.NewGuid(), Report);

        (await ticket.WaitAsync(TimeSpan.FromMilliseconds(50), CancellationToken.None)).Should().BeNull();
    }

    [Fact]
    public void Reports_AReportWithNoCleanupRunningIsIgnored()
    {
        var reports = new InMemoryTvCleanupReports(TimeProvider.System);

        var act = () => reports.Complete(Guid.Empty, Guid.NewGuid(), Report);

        act.Should().NotThrow();
        using var ticket = reports.TryBegin(Guid.Empty);
        ticket.Should().NotBeNull();
    }

    [Fact]
    public async Task Reports_ALateReportOfAnEarlierCleanupNeverReachesTheNextOne()
    {
        var reports = new InMemoryTvCleanupReports(TimeProvider.System);
        var first = reports.TryBegin(Guid.Empty)!;
        var firstId = first.RequestId;
        first.Dispose();
        using var second = reports.TryBegin(Guid.Empty)!;

        reports.Complete(Guid.Empty, firstId, Report);

        (await second.WaitAsync(TimeSpan.FromMilliseconds(50), CancellationToken.None)).Should().BeNull();
    }

    // ---- handler ----

    [Fact]
    public async Task Handler_SendsTheMessageWithTheTicketId_AndTheCleanupOwnTimeout_AndReturnsTheReport()
    {
        var (handler, sender, audit, _) = Build(TvSendOutcome.Ok(TimeSpan.FromMilliseconds(42)));

        var result = await handler.HandleAsync(new CleanupCommand(Origin), CancellationToken.None);

        result.Busy.Should().BeFalse();
        result.Report.Should().BeSameAs(Report);
        sender.Message!.Type.Should().Be("tv.cleanup.v1");
        sender.Timeout.Should().Be(TimeSpan.FromSeconds(30), "a limpeza não usa os 8 s dos outros comandos");
        var row = audit.Entries.Should().ContainSingle().Subject;
        row.Command.Should().Be("tv.cleanup");
        row.Detail.Should().BeNull();
        row.Ok.Should().BeTrue();
    }

    [Fact]
    public async Task Handler_UsesTheConfiguredCleanupTimeout()
    {
        var (handler, sender, _, _) = Build(TvSendOutcome.Ok(TimeSpan.Zero), cleanupTimeoutSeconds: 45);

        _ = await handler.HandleAsync(new CleanupCommand(Origin), CancellationToken.None);

        sender.Timeout.Should().Be(TimeSpan.FromSeconds(45));
    }

    [Fact]
    public void CleanupReportEntry_KeepsTheCompletedMeasurementForPersistence()
    {
        var startedAt = new DateTimeOffset(2026, 10, 27, 16, 5, 0, TimeSpan.Zero);

        var entry = CleanupReportEntry.Completed(
            Guid.NewGuid(), "manual", "manual", startedAt, 1_500, 214, 596, 6, "[]");

        (entry.Kind, entry.Trigger, entry.StartedAt, entry.DurationMs, entry.MemoryBeforeMb, entry.MemoryAfterMb,
            entry.ClosedApps, entry.Result).Should().Be(("manual", "manual", startedAt, 1_500, 214, 596, 6, "completed"));
    }

    [Fact]
    public async Task Handler_WhenTheAgentSaysAnotherCleanupIsRunning_IsBusy()
    {
        var (handler, _, _, _) = Build(TvSendOutcome.Failed(TvSendStatus.CommandFailed, CleanupHandler.AgentBusyCode), agentReports: false);

        var result = await handler.HandleAsync(new CleanupCommand(Origin), CancellationToken.None);

        result.Busy.Should().BeTrue();
    }

    [Fact]
    public async Task Handler_WhileAnotherCleanupHoldsTheTurn_IsBusy_AndNothingReachesTheAgent()
    {
        var (handler, sender, audit, reports) = Build(TvSendOutcome.Ok(TimeSpan.Zero));
        using var other = reports.TryBegin(Guid.Empty);

        var result = await handler.HandleAsync(new CleanupCommand(Origin), CancellationToken.None);

        result.Busy.Should().BeTrue();
        sender.Requests.Should().Be(0);
        audit.Entries.Should().BeEmpty();
    }

    [Fact]
    public async Task Handler_FreesTheTurnEvenWhenTheCommandFails()
    {
        var (handler, _, _, reports) = Build(TvSendOutcome.Failed(TvSendStatus.AgentTimeout, "agent_timeout"), agentReports: false);

        var result = await handler.HandleAsync(new CleanupCommand(Origin), CancellationToken.None);

        result.Outcome!.Status.Should().Be(TvSendStatus.AgentTimeout);
        using var next = reports.TryBegin(Guid.Empty);
        next.Should().NotBeNull();
    }

    // ---- resposta HTTP ----

    [Fact]
    public void Result_WithTheReport_Is200WithEverythingTheAgentSaid()
    {
        var result = CleanupEndpoint.ToResult(new CleanupResult(false, TvSendOutcome.Ok(TimeSpan.FromMilliseconds(1500)), Report));

        var ok = result.Should().BeOfType<Ok<TvCleanupOk>>().Subject.Value!;
        ok.Ok.Should().BeTrue();
        ok.LatencyMs.Should().Be(1500);
        (ok.ClosedApps, ok.FreedMb, ok.MemoryBeforeMb, ok.MemoryAfterMb).Should().Be((6, 382, 214, 596));
        ok.FailedSteps.Should().Equal("force-stop:com.exemplo.player");
    }

    [Fact]
    public void Result_WithUnreadableMemory_KeepsTheNulls()
    {
        var report = new TvCleanupReport(0, null, null, null, []);

        var ok = CleanupEndpoint.ToResult(new CleanupResult(false, TvSendOutcome.Ok(TimeSpan.Zero), report))
            .Should().BeOfType<Ok<TvCleanupOk>>().Subject.Value!;

        ok.FreedMb.Should().BeNull();
        ok.MemoryBeforeMb.Should().BeNull();
        ok.MemoryAfterMb.Should().BeNull();
        ok.ClosedApps.Should().Be(0);
    }

    [Fact]
    public void Result_Busy_Is409WithItsOwnProblemType()
    {
        var problem = CleanupEndpoint.ToResult(new CleanupResult(true, null, null)).Should().BeOfType<ProblemHttpResult>().Subject;

        problem.StatusCode.Should().Be(StatusCodes.Status409Conflict);
        problem.ProblemDetails.Type.Should().EndWith("/cleanup-in-progress");
    }

    [Theory]
    [InlineData(TvSendStatus.AgentOffline, StatusCodes.Status503ServiceUnavailable)]
    [InlineData(TvSendStatus.NotConfigured, StatusCodes.Status503ServiceUnavailable)]
    [InlineData(TvSendStatus.AgentTimeout, StatusCodes.Status504GatewayTimeout)]
    [InlineData(TvSendStatus.CommandFailed, StatusCodes.Status502BadGateway)]
    public void Result_FailuresUseTheSameProblemsAsTheOtherCommands(TvSendStatus status, int expected)
    {
        var problem = CleanupEndpoint.ToResult(new CleanupResult(false, TvSendOutcome.Failed(status, "adb_unreachable"), null))
            .Should().BeOfType<ProblemHttpResult>().Subject;

        problem.StatusCode.Should().Be(expected);
        if (status == TvSendStatus.CommandFailed)
        {
            problem.ProblemDetails.Extensions["agentError"].Should().Be("adb_unreachable");
        }
    }

    [Fact]
    public void Result_CommandOkWithoutAReport_Is502_NotAnInventedSuccess()
    {
        var problem = CleanupEndpoint.ToResult(new CleanupResult(false, TvSendOutcome.Ok(TimeSpan.Zero), null))
            .Should().BeOfType<ProblemHttpResult>().Subject;

        problem.StatusCode.Should().Be(StatusCodes.Status502BadGateway);
        problem.ProblemDetails.Extensions["agentError"].Should().Be(CleanupEndpoint.ReportMissingCode);
    }

    [Fact]
    public void Result_SerializesWithTheNamesTheScreenReads()
    {
        var ok = new TvCleanupOk(true, 10, 6, 382, 214, 596, ["force-stop:com.exemplo.player"]);

        var json = JsonSerializer.Serialize(ok, WebOptions);

        json.Should().Be("{\"ok\":true,\"latencyMs\":10,\"closedApps\":6,\"freedMb\":382,\"memoryBeforeMb\":214,\"memoryAfterMb\":596,\"failedSteps\":[\"force-stop:com.exemplo.player\"]}");
    }
}
