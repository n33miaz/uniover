using System.Globalization;
using System.Text;
using AwesomeAssertions;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Features.Beacons;

namespace UniOver.Modules.Devices.Tests.Beacons;

public class AgentBeaconTests
{
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-11-05T12:00:00Z", CultureInfo.InvariantCulture);

    private static BeaconInput? Parse(string json) => AgentBeaconParser.Parse(Encoding.UTF8.GetBytes(json));

    [Fact]
    public void AFullBeaconIsRead()
    {
        var input = Parse("""{"v":1,"stage":"child_spawn","code":"crash_loop","ver":"0.42.10+3f2a9c1d4e5b","os":"windows 11","n":3,"detail":"Saiu com codigo 3 (2 vezes)"}""");

        input.Should().NotBeNull();
        input!.Stage.Should().Be("child_spawn");
        input.Code.Should().Be("crash_loop");
        input.Version.Should().Be("0.42.10+3f2a9c1d4e5b");
        input.Os.Should().Be("windows 11");
        input.Detail.Should().Be("Saiu com codigo 3 (2 vezes)");
    }

    [Fact]
    public void OnlyStageAndCodeAreRequired()
    {
        var input = Parse("""{"stage":"bootstrap","code":"ok"}""");

        input.Should().NotBeNull();
        input!.Version.Should().BeNull();
        input.Os.Should().BeNull();
        input.Detail.Should().BeNull();
    }

    [Theory]
    [InlineData("")]
    [InlineData("não é json")]
    [InlineData("[]")]
    [InlineData("""{"stage":"bootstrap"}""")]
    [InlineData("""{"code":"ok"}""")]
    [InlineData("""{"stage":"Bootstrap","code":"ok"}""")]
    [InlineData("""{"stage":"bootstrap","code":"ok!"}""")]
    [InlineData("""{"stage":"a","code":"ok"}""")]
    [InlineData("""{"stage":"bootstrap_bootstrap_bootstrap_boot","code":"ok"}""")]
    [InlineData("""{"stage":7,"code":"ok"}""")]
    [InlineData("""{"stage":"bootstrap","code":"ok","extra":{"a":{"b":{"c":{"d":1}}}}}""")]
    public void ABodyOutOfShapeIsDropped(string json) => Parse(json).Should().BeNull();

    [Fact]
    public void ABodyOverTheCapIsDropped()
    {
        var json = $$"""{"stage":"bootstrap","code":"ok","detail":"{{new string('a', 600)}}"}""";

        Parse(json).Should().BeNull();
    }

    [Fact]
    public void ABadOptionalFieldIsDroppedButTheBeaconStays()
    {
        var input = Parse("""{"stage":"bootstrap","code":"ok","ver":"x y","os":"<script>","detail":"C:\\Users\\ana\\x"}""");

        input.Should().NotBeNull();
        input!.Version.Should().BeNull();
        input.Os.Should().BeNull();
        input.Detail.Should().BeNull();
    }

    [Theory]
    [InlineData("C:\\Users\\ana\\agent.log")]
    [InlineData("/home/ana/.config")]
    [InlineData("ana@example.com")]
    [InlineData("https://example.com/x")]
    [InlineData("token=abc")]
    [InlineData("uo_dev_short")]
    [InlineData("Authorization abcdefghijklmnopqrstuvwxyz0123456789")]
    [InlineData("linha\nnova")]
    public void ADetailThatCouldCarryASecretOrAPathIsDropped(string detail) =>
        AgentBeaconParser.CleanDetail(detail).Should().BeNull();

    [Fact]
    public void ADetailIsTrimmedAndCappedAt200()
    {
        AgentBeaconParser.CleanDetail("  Sem rede  ").Should().Be("Sem rede");
        AgentBeaconParser.CleanDetail(new string('a', 201)).Should().BeNull();
        AgentBeaconParser.CleanDetail(string.Join(" ", Enumerable.Repeat("ab", 67))).Should().HaveLength(200);
        AgentBeaconParser.CleanDetail(string.Join(" ", Enumerable.Repeat("ab", 68))).Should().BeNull();
        AgentBeaconParser.CleanDetail(null).Should().BeNull();
        AgentBeaconParser.CleanDetail("   ").Should().BeNull();
    }

    [Fact]
    public void TheFirstFailureIsRemembered_AndAnOkClearsIt()
    {
        var beacon = AgentBeacon.Create(Guid.NewGuid());

        beacon.ApplyBeacon("bootstrap", "ok", null, "1.0", "windows", T0);
        beacon.FirstFailAt.Should().BeNull();

        beacon.ApplyBeacon("supervisor", "no_config", null, "1.0", "windows", T0.AddMinutes(1));
        beacon.FirstFailAt.Should().Be(T0.AddMinutes(1));

        beacon.ApplyBeacon("supervisor", "crash_loop", null, "1.0", "windows", T0.AddMinutes(9));
        beacon.FirstFailAt.Should().Be(T0.AddMinutes(1));
        beacon.LastCode.Should().Be("crash_loop");

        beacon.ApplyBeacon("hello_sent", "ok", null, "1.0", "windows", T0.AddMinutes(20));
        beacon.FirstFailAt.Should().BeNull();
        beacon.Count.Should().Be(4);
        beacon.Verified.Should().BeFalse();
    }

    [Fact]
    public void ARepeatOfTheSameStageAndCodeInsideTheWindowIsDetected()
    {
        var beacon = AgentBeacon.Create(Guid.NewGuid());
        var window = TimeSpan.FromMinutes(5);
        beacon.IsRepeat("bootstrap", "ok", T0, window).Should().BeFalse();

        beacon.ApplyBeacon("bootstrap", "ok", null, null, null, T0);

        beacon.IsRepeat("bootstrap", "ok", T0.AddMinutes(4), window).Should().BeTrue();
        beacon.IsRepeat("bootstrap", "ok", T0.AddMinutes(5), window).Should().BeFalse();
        beacon.IsRepeat("supervisor", "ok", T0.AddMinutes(1), window).Should().BeFalse();
        beacon.IsRepeat("bootstrap", "no_config", T0.AddMinutes(1), window).Should().BeFalse();
    }

    [Fact]
    public void ARejectionKeepsTheBeaconAsItWas()
    {
        var beacon = AgentBeacon.Create(Guid.NewGuid());
        beacon.ApplyBeacon("bootstrap", "ok", null, null, null, T0);

        beacon.ApplyRejection("revoked", T0.AddMinutes(2));

        beacon.LastRejectReason.Should().Be("revoked");
        beacon.LastRejectedAt.Should().Be(T0.AddMinutes(2));
        beacon.LastStage.Should().Be("bootstrap");
        beacon.LastAt.Should().Be(T0);
    }

    [Fact]
    public void TheGateLimitsBeaconsPerAgentPerMinute_AndStartsOverAfterTheWindow()
    {
        var time = new FakeTimeProvider(T0);
        var gate = new AgentBeaconGate(time);
        var agent = Guid.NewGuid();

        Enumerable.Range(0, BeaconLimits.PerAgentPerMinute).Should().AllSatisfy(_ => gate.TryAcceptBeacon(agent).Should().BeTrue());
        gate.TryAcceptBeacon(agent).Should().BeFalse();
        gate.TryAcceptBeacon(Guid.NewGuid()).Should().BeTrue();

        time.Advance(BeaconLimits.Window);
        gate.TryAcceptBeacon(agent).Should().BeTrue();
    }

    [Fact]
    public void TheGateAcceptsOneRejectionPerInterval()
    {
        var time = new FakeTimeProvider(T0);
        var gate = new AgentBeaconGate(time);
        var agent = Guid.NewGuid();

        gate.TryAcceptRejection(agent).Should().BeTrue();
        gate.TryAcceptRejection(agent).Should().BeFalse();
        gate.TryAcceptRejection(Guid.NewGuid()).Should().BeTrue();

        time.Advance(BeaconLimits.RejectionInterval);
        gate.TryAcceptRejection(agent).Should().BeTrue();
    }
}
