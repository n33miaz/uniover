using System.Diagnostics;
using System.Net;
using AwesomeAssertions;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Edge;

public class StartupTests
{
    [Fact]
    public async Task HealthLive_DoesNotTouchTheDatabase()
    {
        // Host de banco inexistente: se /health/live consultasse o banco, falharia ou demoraria.
        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Default"] = "Host=banco-inexistente.invalid;Database=d;Username=u;Password=p;Timeout=15",
        };
        await using var factory = new EdgeFactory("Production", settings, withTestModule: true);
        using var client = factory.CreateClient();

        var clock = Stopwatch.StartNew();
        var response = await client.GetAsync("/health/live", TestContext.Current.CancellationToken);
        clock.Stop();

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        clock.Elapsed.Should().BeLessThan(TimeSpan.FromSeconds(3));
    }

    [Fact]
    public async Task Production_StartsWithOnlyTheRuntimeConnection_NoMigrationsConnection()
    {
        Environment.GetEnvironmentVariable("UNIOVER_MIGRATIONS_CONNECTION").Should().BeNull(
            "a conexão de migrations não pode existir no ambiente da aplicação");
        var settings = new Dictionary<string, string?> { ["ConnectionStrings:Default"] = "Host=h;Database=d;Username=u;Password=p" };
        await using var factory = new EdgeFactory("Production", settings, withTestModule: true);

        using var client = factory.CreateClient();

        (await client.GetAsync("/health/live", TestContext.Current.CancellationToken)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Production_WithoutDefaultConnection_FailsFastOnStart()
    {
        await using var factory = new EdgeFactory("Production", withTestModule: true);

        var act = () => { using var client = factory.CreateClient(); };

        var error = act.Should().Throw<Exception>().Which;
        error.ToString().Should().Contain("ConnectionStrings:Default");
        await Task.CompletedTask;
    }

    [Fact]
    public async Task Development_WithoutConnection_StillStarts()
    {
        await using var factory = new EdgeFactory("Development", withTestModule: true);
        using var client = factory.CreateClient();

        (await client.GetAsync("/health/live", TestContext.Current.CancellationToken)).StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
