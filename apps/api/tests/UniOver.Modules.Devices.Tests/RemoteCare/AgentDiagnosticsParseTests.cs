using System.Text.Json;
using AwesomeAssertions;
using UniOver.Modules.Devices.Features.Diagnostics;

namespace UniOver.Modules.Devices.Tests.RemoteCare;

public sealed class AgentDiagnosticsParseTests
{
    private static JsonElement Body(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private static string Item(string kind = "background.failed", string severity = "error", string detail = "x", string extra = "") =>
        $$"""{ "id": "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8eb2", "at": "2026-10-31T13:41:10Z", "kind": "{{kind}}", "severity": "{{severity}}", "detail": "{{detail}}"{{extra}} }""";

    [Fact]
    public void AValidItemIsReadWithItsOptionalFields()
    {
        var parsed = AgentDiagnosticsStore.Parse(Body($$"""{ "events": [ {{Item(extra: ", \"component\": \"tv.session\", \"count\": 3")}} ] }"""));

        var input = parsed.Should().ContainSingle().Subject;
        input.Kind.Should().Be("background.failed");
        input.Severity.Should().Be("error");
        input.Component.Should().Be("tv.session");
        input.Count.Should().Be(3);
        input.At.Should().Be(new DateTimeOffset(2026, 10, 31, 13, 41, 10, TimeSpan.Zero));
    }

    [Fact]
    public void WithoutCountItCountsOnce_AndAHugeCountIsClamped()
    {
        AgentDiagnosticsStore.Parse(Body($$"""{ "events": [ {{Item()}} ] }""")).Single().Count.Should().Be(1);
        AgentDiagnosticsStore.Parse(Body($$"""{ "events": [ {{Item(extra: ", \"count\": 99999999")}} ] }""")).Single().Count.Should().Be(10_000);
    }

    [Theory]
    [InlineData("Bad Kind")]
    [InlineData("C:\\\\Users\\\\fulano")]
    [InlineData("x")]
    public void AKindOutOfShapeIsSkipped(string kind) =>
        AgentDiagnosticsStore.Parse(Body($$"""{ "events": [ {{Item(kind: kind)}} ] }""")).Should().BeEmpty();

    [Fact]
    public void ASeverityOrDetailOutOfShapeIsSkipped_ButGoodItemsAroundItStay()
    {
        var tooLong = new string('x', 301);
        var parsed = AgentDiagnosticsStore.Parse(Body(
            $$"""{ "events": [ {{Item(detail: "ok")}}, {{Item(severity: "fatal")}}, {{Item(detail: tooLong)}}, {{Item(detail: "")}} ] }"""));

        parsed.Should().ContainSingle().Which.Detail.Should().Be("ok");
    }

    [Theory]
    [InlineData("""{ "events": "nope" }""")]
    [InlineData("""{ "other": [] }""")]
    [InlineData("""[]""")]
    [InlineData("""{ "events": [ 1, "a", null ] }""")]
    public void ABodyOutOfShapeGivesNothing(string json) =>
        AgentDiagnosticsStore.Parse(Body(json)).Should().BeEmpty();
}
