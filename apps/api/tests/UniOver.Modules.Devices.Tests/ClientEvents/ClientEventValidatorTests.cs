using AwesomeAssertions;
using UniOver.Modules.Devices.Features.ClientEvents;

namespace UniOver.Modules.Devices.Tests.ClientEvents;

/// <summary>A conferência de cada ocorrência da telemetria do app: só formas fixas entram, e nada é "consertado".</summary>
public sealed class ClientEventValidatorTests
{
    private static readonly DateTimeOffset At = new(2026, 11, 10, 14, 0, 0, TimeSpan.Zero);

    private static ClientEventItem Item(
        Guid? id = null,
        string? kind = "command-failure",
        string? module = "tv",
        string? code = "network",
        int? status = null,
        string? traceId = null,
        string? transport = null,
        string? visibility = "visible",
        string? route = "/tv",
        string? api = null,
        string? version = "0.54.0",
        bool? grace = false) =>
        new(id ?? Guid.NewGuid(), At, kind, module, code, status, traceId, transport, visibility, route, api, version, grace);

    [Fact]
    public void AFullEventIsAccepted_AsItCame()
    {
        var id = Guid.NewGuid();
        var item = Item(id, "http-failure", "pc", "http_503", 503, "4bf92f3577b34da6a3ce929d0e0e4736", "cloud", "hidden", "/pc/mouse", "/api/v1/pc/click", "0.54.0", true);

        var valid = ClientEventValidator.Validate(item);

        valid.Should().NotBeNull();
        valid!.EventId.Should().Be(id);
        valid.Kind.Should().Be("http-failure");
        valid.Module.Should().Be("pc");
        valid.Code.Should().Be("http_503");
        valid.Status.Should().Be(503);
        valid.TraceId.Should().Be("4bf92f3577b34da6a3ce929d0e0e4736");
        valid.Transport.Should().Be("cloud");
        valid.Visibility.Should().Be("hidden");
        valid.Route.Should().Be("/pc/mouse");
        valid.Api.Should().Be("/api/v1/pc/click");
        valid.Grace.Should().BeTrue();
    }

    [Fact]
    public void OnlyTheRequiredFieldsAreNeeded()
    {
        var valid = ClientEventValidator.Validate(Item(code: null, version: null, grace: null));

        valid.Should().NotBeNull();
        valid!.Code.Should().BeNull();
        valid.Version.Should().BeNull();
        valid.Grace.Should().BeFalse();
    }

    [Theory]
    [InlineData("kind", "outro")]
    [InlineData("kind", null)]
    [InlineData("module", "financeiro")]
    [InlineData("module", null)]
    [InlineData("visibility", "prerender")]
    [InlineData("visibility", null)]
    [InlineData("transport", "bluetooth")]
    public void AValueOutsideTheFixedSetsIsRefused(string field, string? value)
    {
        var item = field switch
        {
            "kind" => Item(kind: value),
            "module" => Item(module: value),
            "visibility" => Item(visibility: value),
            _ => Item(transport: value),
        };

        ClientEventValidator.Validate(item).Should().BeNull();
    }

    [Theory]
    [InlineData("a senha 1234 digitada")]
    [InlineData("<script>")]
    [InlineData("Error: falha em C:\\Users\\fulano")]
    [InlineData("")]
    [InlineData("-comeca-com-hifen")]
    public void ACodeThatIsNotAShortCodeIsRefused_NeverStoredAsFreeText(string code) =>
        ClientEventValidator.Validate(Item(code: code)).Should().BeNull();

    [Fact]
    public void ACodeTooLongIsRefused() =>
        ClientEventValidator.Validate(Item(code: new string('a', 49))).Should().BeNull();

    [Theory]
    [InlineData("tv")]
    [InlineData("/tv?token=segredo")]
    [InlineData("/treino/minha rotina")]
    [InlineData("/treino/açaí")]
    [InlineData("/a#b")]
    public void ARouteWithoutTheSafeShapeIsRefused(string route) =>
        ClientEventValidator.Validate(Item(route: route)).Should().BeNull();

    [Fact]
    public void ARouteTooLongIsRefused() =>
        ClientEventValidator.Validate(Item(route: "/" + new string('a', 120))).Should().BeNull();

    [Fact]
    public void ARouteWithIdPlaceholdersIsAccepted() =>
        ClientEventValidator.Validate(Item(route: "/treino/sessoes/:id/series/:id")).Should().NotBeNull();

    [Theory]
    [InlineData("curto")]
    [InlineData("com espaço no meio do rastro")]
    [InlineData("rastro;drop table")]
    public void ATraceIdThatIsNotAnIdentifierIsRefused(string trace) =>
        ClientEventValidator.Validate(Item(traceId: trace)).Should().BeNull();

    [Theory]
    [InlineData("não é versão")]
    [InlineData("-1")]
    public void AVersionThatIsNotAVersionIsRefused(string version) =>
        ClientEventValidator.Validate(Item(version: version)).Should().BeNull();

    [Theory]
    [InlineData(-1)]
    [InlineData(600)]
    [InlineData(99_999)]
    public void AnImpossibleStatusIsRefused(int status) =>
        ClientEventValidator.Validate(Item(status: status)).Should().BeNull();

    [Theory]
    [InlineData(0)]
    [InlineData(504)]
    [InlineData(599)]
    public void AStatusFromZeroToFiveNinetyNineIsAccepted(int status) =>
        ClientEventValidator.Validate(Item(status: status)).Should().NotBeNull();

    [Fact]
    public void WithoutAnIdOrATimeItIsRefused()
    {
        ClientEventValidator.Validate(Item() with { Id = null }).Should().BeNull();
        ClientEventValidator.Validate(Item() with { Id = Guid.Empty }).Should().BeNull();
        ClientEventValidator.Validate(Item() with { At = null }).Should().BeNull();
    }

    [Fact]
    public void ARefusedEventNeverTurnsIntoAFixedUpOne() =>
        // O texto livre não é cortado nem limpo para caber: a ocorrência inteira some.
        ClientEventValidator.Validate(Item(code: "TypeError: senha=1234")).Should().BeNull();
}
