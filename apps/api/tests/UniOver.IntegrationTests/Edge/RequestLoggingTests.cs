using System.Net;
using AwesomeAssertions;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Edge;

/// <summary>
/// Uma linha de log por requisição, útil para diagnosticar partida a frio e falha de agente, e sem nada que identifique a
/// pessoa: rota (o padrão) e não a URL, nenhuma query, nenhum cabeçalho, corpo ou IP.
/// </summary>
public class RequestLoggingTests
{
    private static (EdgeFactory Root, HttpClient Client, CapturingLoggerProvider Logs) Start(
        IReadOnlyDictionary<string, string?>? settings = null)
    {
        var logs = new CapturingLoggerProvider();
        var root = new EdgeFactory("Development", settings, withTestEndpoints: true);
        var factory = root.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.AddSingleton<ILoggerProvider>(logs);
        }));
        return (root, factory.CreateClient(), logs);
    }

    private static IReadOnlyList<string> RequestLines(CapturingLoggerProvider logs) =>
        [.. logs.Lines.Where(l => l.Contains("RequestLoggingMiddleware", StringComparison.Ordinal))];

    [Fact]
    public async Task ARequestWritesOneLineWithMethodRouteStatusAndDuration_AndNeverTheQueryString()
    {
        var (root, client, logs) = Start();
        await using var _r = root;
        using var _c = client;

        using var response = await client.GetAsync("/api/test/validation?token=uo_dev_segredo&email=a@b.c", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var line = RequestLines(logs).Should().ContainSingle().Subject;
        line.Should().Contain("HTTP GET /api/test/validation respondeu 400 em ");
        line.Should().NotContain("uo_dev_segredo").And.NotContain("a@b.c").And.NotContain("?");
    }

    [Fact]
    public async Task TheRouteIsThePattern_NotTheRealPath()
    {
        var (root, client, logs) = Start();
        await using var _r = root;
        using var _c = client;

        using var response = await client.GetAsync("/api/v1/devices/agents/pc-do-fulano/ws", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        var line = RequestLines(logs).Should().ContainSingle().Subject;
        line.Should().Contain("/api/v1/devices/agents/{agentId}/ws");
        line.Should().NotContain("pc-do-fulano");
    }

    [Fact]
    public async Task AnUnknownPath_IsLoggedWithoutThePathItself()
    {
        var (root, client, logs) = Start();
        await using var _r = root;
        using var _c = client;

        using var response = await client.GetAsync("/api/v1/nao-existe-segredo", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
        var line = RequestLines(logs).Should().ContainSingle().Subject;
        line.Should().NotContain("nao-existe-segredo");
    }

    [Fact]
    public async Task EveryResponse_CarriesTheTraceIdHeader()
    {
        var (root, client, _) = Start();
        await using var _r = root;
        using var _c = client;

        using var ok = await client.GetAsync("/health/live", TestContext.Current.CancellationToken);
        using var error = await client.GetAsync("/api/test/boom", TestContext.Current.CancellationToken);

        ok.Headers.TryGetValues("X-Trace-Id", out var okValues).Should().BeTrue();
        okValues!.Single().Should().MatchRegex("^[0-9a-f]{32}$");
        error.StatusCode.Should().Be(HttpStatusCode.InternalServerError);
        error.Headers.TryGetValues("X-Trace-Id", out var errorValues).Should().BeTrue("a resposta de erro do tratador global também leva o cabeçalho");
        var body = await error.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        body.Should().Contain(errorValues!.Single(), "o traceId do erro contém o mesmo identificador do cabeçalho");
    }

    [Fact]
    public async Task TheHealthProbe_IsOnlyLoggedAtDebug_AndAServerErrorIsAWarning()
    {
        // Debug só entra no log se o nível mínimo deixar: o padrão do Host é Information.
        var (root, client, logs) = Start(new Dictionary<string, string?> { ["Logging:LogLevel:Default"] = "Debug" });
        await using var _r = root;
        using var _c = client;

        using var live = await client.GetAsync("/health/live", TestContext.Current.CancellationToken);
        using var boom = await client.GetAsync("/api/test/boom", TestContext.Current.CancellationToken);

        var lines = RequestLines(logs);
        lines.Should().Contain(l => l.StartsWith("Debug", StringComparison.Ordinal) && l.Contains("/health/live", StringComparison.Ordinal));
        lines.Should().Contain(l => l.StartsWith("Warning", StringComparison.Ordinal) && l.Contains("/api/test/boom", StringComparison.Ordinal) && l.Contains("500", StringComparison.Ordinal));
        lines.Should().NotContain(l => l.StartsWith("Information", StringComparison.Ordinal) && l.Contains("/health/live", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ASlowRequest_IsAWarning()
    {
        var (root, client, logs) = Start(new Dictionary<string, string?> { ["RequestLogging:SlowMilliseconds"] = "100" });
        await using var _r = root;
        using var _c = client;

        using var response = await client.GetAsync("/api/test/slow", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        RequestLines(logs).Should().Contain(l => l.StartsWith("Warning", StringComparison.Ordinal) && l.Contains("/api/test/slow", StringComparison.Ordinal));
    }
}
