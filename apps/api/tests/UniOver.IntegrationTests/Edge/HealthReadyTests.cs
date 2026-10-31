using System.Diagnostics;
using System.Net;
using AwesomeAssertions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Messaging;

namespace UniOver.IntegrationTests.Edge;

/// <summary>
/// <c>/health/live</c> é a sonda do monitor de 5 em 5 minutos e nunca toca no banco; <c>/health/ready</c> consulta o banco.
/// A separação é o que mantém o Neon gratuito dormindo entre uma visita e outra.
/// </summary>
public sealed class HealthReadyTests
{
    private const string UnreachableDatabase = "Host=banco-inexistente.invalid;Database=d;Username=u;Password=segredo-do-banco;Timeout=3";

    [Fact]
    public async Task WithTheDatabaseDown_LiveStaysUp_AndReadyIs503WithoutLeakingTheConnection()
    {
        var settings = new Dictionary<string, string?> { ["ConnectionStrings:Default"] = UnreachableDatabase };
        await using var factory = new EdgeFactory("Production", settings, withTestModule: true);
        using var client = factory.CreateClient();

        var clock = Stopwatch.StartNew();
        using var live = await client.GetAsync("/health/live", TestContext.Current.CancellationToken);
        clock.Stop();
        using var ready = await client.GetAsync("/health/ready", TestContext.Current.CancellationToken);

        live.StatusCode.Should().Be(HttpStatusCode.OK);
        clock.Elapsed.Should().BeLessThan(TimeSpan.FromSeconds(2), "a sonda de vida não pode esperar o banco");
        ready.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        var body = await ready.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        body.Should().Be("Unhealthy");
        body.Should().NotContain("inexistente").And.NotContain("segredo-do-banco");
    }

    [Fact]
    public async Task Ready_IsLimitedPerIp()
    {
        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Default"] = UnreachableDatabase,
            ["RateLimiting:health-ready:Permitted"] = "2",
        };
        await using var factory = new EdgeFactory("Production", settings, withTestModule: true);
        using var client = factory.CreateClient();

        var codes = new List<HttpStatusCode>();
        for (var i = 0; i < 4; i++)
        {
            using var response = await client.GetAsync("/health/ready", TestContext.Current.CancellationToken);
            codes.Add(response.StatusCode);
        }

        codes.Count(c => c == HttpStatusCode.TooManyRequests).Should().Be(2);
        codes.Take(2).Should().AllSatisfy(c => c.Should().Be(HttpStatusCode.ServiceUnavailable));
    }

    [Fact]
    public async Task TheCheck_ReusesTheResultInsideTheCacheWindow_AndProbesAgainAfterIt()
    {
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 10, 31, 12, 0, 0, TimeSpan.Zero));
        var logger = new CountingLogger();
        var check = new DatabaseHealthCheck(
            Options.Create(new DatabaseOptions { ConnectionString = UnreachableDatabase, ConnectionTimeoutSeconds = 3 }),
            time,
            logger);
        var ct = TestContext.Current.CancellationToken;

        (await check.CheckHealthAsync(null!, ct)).Status.Should().Be(Microsoft.Extensions.Diagnostics.HealthChecks.HealthStatus.Unhealthy);
        (await check.CheckHealthAsync(null!, ct)).Status.Should().Be(Microsoft.Extensions.Diagnostics.HealthChecks.HealthStatus.Unhealthy);
        logger.Warnings.Should().Be(1, "o segundo pedido, dentro dos 5 s, não abre outra conexão");

        time.Advance(DatabaseHealthCheck.UnhealthyCacheLifetime + TimeSpan.FromSeconds(1));
        await check.CheckHealthAsync(null!, ct);
        logger.Warnings.Should().Be(2);
    }

    private sealed class CountingLogger : ILogger<DatabaseHealthCheck>
    {
        public int Warnings { get; private set; }

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (logLevel == LogLevel.Warning)
            {
                Warnings++;
            }
        }
    }
}
