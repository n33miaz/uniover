using System.Text.Json;
using AwesomeAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Ports;
using UniOver.Modules.Tv.Tests.Support;

namespace UniOver.Modules.Tv.Tests.Commands;

public class TvCommandRunnerTests
{
    private static readonly TvMessage Message = new("tv.key.v2", JsonSerializer.SerializeToElement(new { key = "OK" }));
    private static readonly TvCommandOrigin Origin = new(Guid.NewGuid(), new ClientInfo("203.0.113.1", "teste"));

    private sealed class FakeSender(TvSendOutcome outcome) : ITvCommandSender
    {
        public TimeSpan? LastTimeout { get; private set; }

        public int Requests { get; private set; }

        public int Posts { get; private set; }

        public Task<TvSendOutcome> RequestAsync(string agentId, TvMessage message, TimeSpan timeout, CancellationToken cancellationToken)
        {
            Requests++;
            LastTimeout = timeout;
            return Task.FromResult(outcome);
        }

        public Task<TvSendOutcome> PostAsync(string agentId, TvMessage message, CancellationToken cancellationToken)
        {
            Posts++;
            return Task.FromResult(outcome);
        }
    }

    private sealed class FakeAudit(bool fail = false) : ITvCommandAudit
    {
        public List<CommandAuditEntry> Entries { get; } = [];

        public Task RecordAsync(CommandAuditEntry entry, CancellationToken cancellationToken)
        {
            if (fail)
            {
                throw new InvalidOperationException("banco fora do ar");
            }

            Entries.Add(entry);
            return Task.CompletedTask;
        }
    }

    private sealed class FakeStream : ITvStreamPublisher
    {
        public List<TvState> States { get; } = [];

        public void PublishState(TvState state) => States.Add(state);

        public void PublishShortcuts(IReadOnlyList<TvShortcut> shortcuts)
        {
        }

        public void PublishWatchdog(TvWatchdogEntry entry)
        {
        }
    }

    private static (TvCommandRunner Runner, FakeSender Sender, FakeAudit Audit, FakeStream Stream, InMemoryTvStateStore State) Build(
        TvSendOutcome outcome, string agentId = "pc-casa", bool auditFails = false)
    {
        var sender = new FakeSender(outcome);
        var audit = new FakeAudit(auditFails);
        var stream = new FakeStream();
        var state = new InMemoryTvStateStore();
        var options = Options.Create(new TvModuleOptions { AgentId = agentId, CommandTimeoutSeconds = 8, HibernatingTimeoutSeconds = 15 });
        var runner = new TvCommandRunner(options, new FixedAgentResolver(agentId), sender, state, audit, stream, TimeProvider.System, NullLogger<TvCommandRunner>.Instance);
        return (runner, sender, audit, stream, state);
    }

    [Fact]
    public async Task Delivered_RecordsAnOkRowWithWhoAndWhere()
    {
        var (runner, sender, audit, _, _) = Build(TvSendOutcome.Ok(TimeSpan.FromMilliseconds(42)));

        var outcome = await runner.RunAsync(Origin, TvCommandNames.Key, "OK", Message, waitForReply: true, CancellationToken.None);

        outcome.IsDelivered.Should().BeTrue();
        sender.Requests.Should().Be(1);
        var row = audit.Entries.Should().ContainSingle().Subject;
        row.UserId.Should().Be(Origin.UserId);
        row.AgentId.Should().Be("pc-casa");
        row.Command.Should().Be("tv.key");
        row.Detail.Should().Be("OK");
        row.Ok.Should().BeTrue();
        row.ErrorCode.Should().BeNull();
        row.LatencyMs.Should().Be(42);
        row.Ip.Should().Be("203.0.113.1");
        row.UserAgent.Should().Be("teste");
    }

    [Fact]
    public async Task AgentOffline_IsStillAudited_AndAnnouncedToTheScreenOnlyOnce()
    {
        var (runner, _, audit, stream, _) = Build(TvSendOutcome.Failed(TvSendStatus.AgentOffline, "agent_offline"));

        await runner.RunAsync(Origin, TvCommandNames.Key, "OK", Message, waitForReply: true, CancellationToken.None);
        await runner.RunAsync(Origin, TvCommandNames.Key, "OK", Message, waitForReply: true, CancellationToken.None);

        audit.Entries.Should().HaveCount(2);
        audit.Entries.Should().OnlyContain(e => !e.Ok && e.ErrorCode == "agent_offline" && e.LatencyMs == null);
        stream.States.Should().ContainSingle().Which.Connection.Should().Be("disconnected");
    }

    [Fact]
    public async Task Timeout_IsAudited_WithItsCode()
    {
        var (runner, _, audit, _, _) = Build(TvSendOutcome.Failed(TvSendStatus.AgentTimeout, "agent_timeout", latency: TimeSpan.FromSeconds(8)));

        await runner.RunAsync(Origin, TvCommandNames.Text, "length=5", Message, waitForReply: true, CancellationToken.None);

        var row = audit.Entries.Should().ContainSingle().Subject;
        row.Ok.Should().BeFalse();
        row.ErrorCode.Should().Be("agent_timeout");
        row.Detail.Should().Be("length=5");
    }

    [Fact]
    public async Task AgentFailure_KeepsTheAgentErrorCode()
    {
        var (runner, _, audit, _, _) = Build(TvSendOutcome.Failed(TvSendStatus.CommandFailed, "TV_UNREACHABLE", "sem rota"));

        await runner.RunAsync(Origin, TvCommandNames.Key, "OK", Message, waitForReply: true, CancellationToken.None);

        audit.Entries.Single().ErrorCode.Should().Be("TV_UNREACHABLE");
    }

    [Fact]
    public async Task NoAgentConfigured_SendsNothing_ButIsAudited()
    {
        var (runner, sender, audit, _, _) = Build(TvSendOutcome.Ok(TimeSpan.Zero), agentId: "");

        var outcome = await runner.RunAsync(Origin, TvCommandNames.Key, "OK", Message, waitForReply: true, CancellationToken.None);

        outcome.Status.Should().Be(TvSendStatus.NotConfigured);
        sender.Requests.Should().Be(0);
        var row = audit.Entries.Should().ContainSingle().Subject;
        row.AgentId.Should().BeNull();
        row.ErrorCode.Should().Be("agent_not_configured");
    }

    [Fact]
    public async Task AuditFailure_DoesNotStopTheCommand()
    {
        var (runner, _, audit, _, _) = Build(TvSendOutcome.Ok(TimeSpan.FromMilliseconds(5)), auditFails: true);

        var outcome = await runner.RunAsync(Origin, TvCommandNames.Key, "OK", Message, waitForReply: true, CancellationToken.None);

        outcome.IsDelivered.Should().BeTrue();
        audit.Entries.Should().BeEmpty();
    }

    [Fact]
    public async Task AuditFailure_LogsOnlyTheErrorType_NeverTheExceptionOrItsMessage()
    {
        var logger = new CapturingLogger<TvCommandRunner>();
        var runner = new TvCommandRunner(
            Options.Create(new TvModuleOptions { AgentId = "pc-casa" }),
            new FixedAgentResolver("pc-casa"),
            new FakeSender(TvSendOutcome.Ok(TimeSpan.FromMilliseconds(5))),
            new InMemoryTvStateStore(),
            new SecretFailingAudit(),
            new FakeStream(),
            TimeProvider.System,
            logger);

        await runner.RunAsync(Origin, TvCommandNames.Key, "OK", Message, waitForReply: true, CancellationToken.None);

        var line = logger.Lines.Should().ContainSingle().Subject;
        line.Exception.Should().BeNull("a exceção inteira carrega a mensagem do driver");
        line.Message.Should().Contain(nameof(InvalidOperationException));
        logger.Everything.Should().NotContain("ep-segredo").And.NotContain("senha-do-banco");
    }

    private sealed class SecretFailingAudit : ITvCommandAudit
    {
        public Task RecordAsync(CommandAuditEntry entry, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("Host=ep-segredo.neon.tech;Password=senha-do-banco");
    }

    [Fact]
    public async Task TimeoutIsLonger_WhenTheSessionWithTheTvIsHibernating()
    {
        var (runner, sender, _, _, state) = Build(TvSendOutcome.Ok(TimeSpan.Zero));

        await runner.RunAsync(Origin, TvCommandNames.Key, "OK", Message, waitForReply: true, CancellationToken.None);
        sender.LastTimeout.Should().Be(TimeSpan.FromSeconds(8));

        state.Apply("pc-casa", new TvStateSnapshot("on", null, null, "hibernating", DateTimeOffset.UtcNow));
        await runner.RunAsync(Origin, TvCommandNames.Key, "OK", Message, waitForReply: true, CancellationToken.None);
        sender.LastTimeout.Should().Be(TimeSpan.FromSeconds(15));
    }

    [Fact]
    public async Task WakeStyleCommands_DoNotWaitForAReply()
    {
        var (runner, sender, audit, _, _) = Build(TvSendOutcome.Ok(TimeSpan.Zero));

        await runner.RunAsync(Origin, TvCommandNames.Wake, null, Message, waitForReply: false, CancellationToken.None);

        sender.Posts.Should().Be(1);
        sender.Requests.Should().Be(0);
        audit.Entries.Should().ContainSingle();
    }

    [Theory]
    [InlineData(TvSendStatus.AgentOffline, 503, "agent-offline")]
    [InlineData(TvSendStatus.AgentTimeout, 504, "agent-timeout")]
    [InlineData(TvSendStatus.CommandFailed, 502, "command-failed")]
    [InlineData(TvSendStatus.NotConfigured, 503, "agent-not-configured")]
    [InlineData(TvSendStatus.InvalidMessage, 500, "internal-error")]
    public void Problems_MapEachFailureToItsStatusAndType(TvSendStatus status, int expectedStatus, string expectedType)
    {
        var (httpStatus, type, title) = TvProblems.Describe(status);

        httpStatus.Should().Be(expectedStatus);
        type.Should().Be(expectedType);
        title.Should().NotBeNullOrWhiteSpace();
        StatusCodes.Status200OK.Should().NotBe(httpStatus);
    }
}
