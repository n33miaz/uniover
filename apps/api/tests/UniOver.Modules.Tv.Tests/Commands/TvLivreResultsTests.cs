using System.Text.Json;
using AwesomeAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Audit;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.TvLivre;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Tests.Commands;

/// <summary>O TV Livre sem banco nem HTTP: como cada resultado vira problema, a tela montada do estado e o encontro do estado com o pedido.</summary>
public class TvLivreResultsTests
{
    private static readonly JsonSerializerOptions WebOptions = new(JsonSerializerDefaults.Web);

    private static ProblemHttpResult Problem(IResult? result) => result.Should().BeOfType<ProblemHttpResult>().Subject;

    // ---- passo → problema ----

    [Fact]
    public void ADoneStep_HasNoProblem() => TvLivreEndpoint.ToProblem(LivreStep.Done).Should().BeNull();

    [Fact]
    public void ATvWithoutTheCapability_Is409WithItsOwnType()
    {
        var problem = Problem(TvLivreEndpoint.ToProblem(LivreStep.Unsupported));

        problem.StatusCode.Should().Be(StatusCodes.Status409Conflict);
        problem.ProblemDetails.Type.Should().EndWith("/tv-livre-unsupported");
    }

    [Fact]
    public void AStepWhileAnotherRuns_Is409WithADifferentType()
    {
        var problem = Problem(TvLivreEndpoint.ToProblem(LivreStep.Busy));

        problem.StatusCode.Should().Be(StatusCodes.Status409Conflict);
        problem.ProblemDetails.Type.Should().EndWith("/tv-livre-busy");
    }

    [Fact]
    public void TheAgentSayingUnsupported_BecomesTheUnsupportedProblem_KeepingItsCode()
    {
        var step = LivreStep.Failed(TvSendOutcome.Failed(TvSendStatus.CommandFailed, "unsupported"));

        var problem = Problem(TvLivreEndpoint.ToProblem(step));

        problem.StatusCode.Should().Be(StatusCodes.Status409Conflict);
        problem.ProblemDetails.Type.Should().EndWith("/tv-livre-unsupported");
        problem.ProblemDetails.Extensions["agentError"].Should().Be("unsupported");
    }

    /// <summary>Todos os códigos de falha que o agente documenta no contrato, menos o que faz o módulo sumir.</summary>
    public static TheoryData<string> AgentCodes =>
    [
        "not_installed", "invalid_config", "photo_missing", "invalid_photo", "no_files_dir", "push_failed",
        "no_factory_launcher", "signature_mismatch", "install_failed", "apk_unavailable", "apk_hash_mismatch",
        "apk_invalid", "set_home_failed", "verify_failed", "disable_failed", "enable_failed", "uninstall_failed",
        "protected_package", "invalid_package", "sleep_failed", "unknown_action", "livre_failed", "send_failed",
        "adb_unreachable", "adb_timeout",
    ];

    [Theory]
    [MemberData(nameof(AgentCodes))]
    public void AnAgentFailure_Is502_AndTheStableCodeTravelsInTheProblem(string code)
    {
        var problem = Problem(TvLivreEndpoint.ToProblem(LivreStep.Failed(TvSendOutcome.Failed(TvSendStatus.CommandFailed, code))));

        problem.StatusCode.Should().Be(StatusCodes.Status502BadGateway);
        problem.ProblemDetails.Type.Should().EndWith("/command-failed");
        problem.ProblemDetails.Extensions["agentError"].Should().Be(code, "a tela traduz por este código");
    }

    [Theory]
    [InlineData(TvSendStatus.AgentOffline, StatusCodes.Status503ServiceUnavailable)]
    [InlineData(TvSendStatus.NotConfigured, StatusCodes.Status503ServiceUnavailable)]
    [InlineData(TvSendStatus.AgentTimeout, StatusCodes.Status504GatewayTimeout)]
    public void DeliveryFailures_UseTheSameProblemsAsTheOtherCommands(TvSendStatus status, int expected) =>
        Problem(TvLivreEndpoint.ToProblem(LivreStep.Failed(TvSendOutcome.Failed(status)))).StatusCode.Should().Be(expected);

    [Fact]
    public void ThePhotoProblems_AreTheStatusesTheScreenExpects()
    {
        Problem(LivreProblems.PhotoTooLarge()).StatusCode.Should().Be(StatusCodes.Status413PayloadTooLarge);
        Problem(LivreProblems.NotJpeg()).StatusCode.Should().Be(StatusCodes.Status415UnsupportedMediaType);
    }

    // ---- a resposta da tela ----

    [Fact]
    public void TheView_WithoutAnyRow_IsTheDefaultConfig_NeverAppliedAndWithoutState()
    {
        var view = TvLivreView.From(null, available: true);

        view.Available.Should().BeTrue();
        view.Supported.Should().BeNull();
        view.StateAt.Should().BeNull();
        view.Installed.Should().BeFalse();
        view.IsHome.Should().BeFalse();
        view.DisabledPackages.Should().BeEmpty();
        view.Apps.Should().BeEmpty();
        view.HasPhoto.Should().BeFalse();
        view.Revision.Should().Be(0);
        view.Config.Should().BeSameAs(LivreConfig.Default);
    }

    [Fact]
    public void TheView_SerializesWithTheNamesTheScreenReads()
    {
        var json = JsonSerializer.Serialize(TvLivreView.From(null, available: false), WebOptions);
        using var document = JsonDocument.Parse(json);

        document.RootElement.EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo(
            "available", "supported", "installed", "version", "isHome", "factoryLauncher", "disabledPackages", "apps",
            "stateAt", "config", "hasPhoto", "revision");
        document.RootElement.GetProperty("config").EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo(
            "clock", "wallpaper", "apps", "icons", "builtin", "sleep");
        document.RootElement.GetProperty("supported").ValueKind.Should().Be(JsonValueKind.Null);
        document.RootElement.GetProperty("revision").ValueKind.Should().Be(JsonValueKind.Number);
    }

    [Fact]
    public void TheNames_OfEveryCommandThatTheTrailKeeps_AreListedForTheAudit()
    {
        string[] names =
        [
            TvCommandNames.LivreRefresh, TvCommandNames.LivreInstall, TvCommandNames.LivreApply, TvCommandNames.LivreSetHome,
            TvCommandNames.LivreRestore, TvCommandNames.LivreSetApps, TvCommandNames.LivreSleep,
        ];
        TvAuditNormalizer.Actions.Should().Contain(names);
        names.Should().OnlyContain(name => name.Length <= CommandAuditEntry.CommandMax);
    }

    // ---- as opções ----

    [Fact]
    public void Options_TheLivreTimeoutDefaultsTo90Seconds_AndIsLongerThanTheCleanup()
    {
        var options = new TvModuleOptions();

        options.LivreTimeout.Should().Be(TimeSpan.FromSeconds(90));
        options.LivreTimeout.Should().BeGreaterThan(options.CleanupTimeout);
        TvModuleOptions.IsValid(options).Should().BeTrue();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void Options_ANonPositiveLivreTimeoutIsInvalid(int seconds) =>
        TvModuleOptions.IsValid(new TvModuleOptions { LivreTimeoutSeconds = seconds }).Should().BeFalse();

    // ---- um passo por TV e o encontro do estado ----

    [Fact]
    public void OnlyOneStepRunsPerTv_AndDisposingFreesTheTurn()
    {
        var requests = new InMemoryTvLivreRequests(TimeProvider.System);

        var first = requests.TryBegin(Guid.Empty);
        first.Should().NotBeNull();
        requests.TryBegin(Guid.Empty).Should().BeNull();

        first!.Dispose();
        using var second = requests.TryBegin(Guid.Empty);
        second.Should().NotBeNull();
        second!.RequestId.Should().NotBe(first.RequestId);
    }

    [Fact]
    public void TwoTvs_DoNotShareTheTurn()
    {
        var requests = new InMemoryTvLivreRequests(TimeProvider.System);

        using var first = requests.TryBegin(Guid.NewGuid());
        using var second = requests.TryBegin(Guid.NewGuid());

        first.Should().NotBeNull();
        second.Should().NotBeNull();
    }

    [Fact]
    public async Task TheStoredState_WakesTheWaitOfItsRequestId()
    {
        var requests = new InMemoryTvLivreRequests(TimeProvider.System);
        using var ticket = requests.TryBegin(Guid.Empty)!;

        var waiting = ticket.WaitForStateAsync(TimeSpan.FromSeconds(10), CancellationToken.None);
        requests.StateStored(Guid.Empty, ticket.RequestId);

        (await waiting.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken)).Should().BeTrue();
    }

    [Fact]
    public async Task AStateThatArrivedBeforeTheWait_IsFoundRightAway()
    {
        var requests = new InMemoryTvLivreRequests(TimeProvider.System);
        using var ticket = requests.TryBegin(Guid.Empty)!;

        requests.StateStored(Guid.Empty, ticket.RequestId);

        (await ticket.WaitForStateAsync(TimeSpan.Zero, CancellationToken.None)).Should().BeTrue();
    }

    [Fact]
    public async Task AStateForAnotherRequestId_IsIgnored_AndTheWaitEndsFalse()
    {
        var requests = new InMemoryTvLivreRequests(TimeProvider.System);
        using var ticket = requests.TryBegin(Guid.Empty)!;

        requests.StateStored(Guid.Empty, Guid.NewGuid());

        (await ticket.WaitForStateAsync(TimeSpan.FromMilliseconds(50), CancellationToken.None)).Should().BeFalse();
    }

    [Fact]
    public async Task AStateOfAnotherTv_IsIgnored()
    {
        var requests = new InMemoryTvLivreRequests(TimeProvider.System);
        var tv = Guid.NewGuid();
        using var ticket = requests.TryBegin(tv)!;

        requests.StateStored(Guid.NewGuid(), ticket.RequestId);

        (await ticket.WaitForStateAsync(TimeSpan.FromMilliseconds(50), CancellationToken.None)).Should().BeFalse();
    }

    [Fact]
    public void DisposingAStaleTicket_NeverFreesTheTurnOfANewerOne()
    {
        var requests = new InMemoryTvLivreRequests(TimeProvider.System);
        var first = requests.TryBegin(Guid.Empty)!;
        first.Dispose();
        using var second = requests.TryBegin(Guid.Empty)!;

        first.Dispose();

        requests.TryBegin(Guid.Empty).Should().BeNull("o passo novo segue ocupando a vez");
    }
}
