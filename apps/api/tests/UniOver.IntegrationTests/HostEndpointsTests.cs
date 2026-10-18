using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.AspNetCore.Mvc.Testing;

namespace UniOver.IntegrationTests;

public class HostEndpointsTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client = factory.CreateClient();

    [Fact]
    public async Task HealthLive_Returns200()
    {
        var response = await _client.GetAsync("/health/live", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task TvInfo_ReturnsModuleAndVersion()
    {
        var json = await _client.GetFromJsonAsync<JsonElement>("/api/v1/tv/info", TestContext.Current.CancellationToken);

        json.GetProperty("module").GetString().Should().Be("tv");
        json.GetProperty("version").GetString().Should().Be("0.1.0");
    }

    [Fact]
    public async Task IdentityInfo_ReturnsModuleVersionAndDependency()
    {
        var json = await _client.GetFromJsonAsync<JsonElement>("/api/v1/identity/info", TestContext.Current.CancellationToken);

        json.GetProperty("module").GetString().Should().Be("identity");
        json.GetProperty("version").GetString().Should().Be("0.1.0");
        json.GetProperty("dependsOn").EnumerateArray().Select(e => e.GetString()).Should().Equal("tv");
    }

    [Fact]
    public async Task UnknownApiRoute_Returns404InsteadOfIndexHtml()
    {
        var response = await _client.GetAsync("/api/v1/nao-existe", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Root_ServesIndexHtml()
    {
        var response = await _client.GetAsync("/", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)).Should().Contain("<title>UniOver</title>");
    }
}
