using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AwesomeAssertions;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Edge;

public class RateLimitTests
{
    private static async Task<HttpStatusCode> GetLoginAsync(HttpClient client, string? forwardedFor = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/test/login");
        if (forwardedFor is not null)
        {
            request.Headers.Add("X-Forwarded-For", forwardedFor);
        }

        using var response = await client.SendAsync(request, TestContext.Current.CancellationToken);
        return response.StatusCode;
    }

    [Fact]
    public async Task LoginPolicy_Returns200UntilTheLimitThen429WithRetryAfterAndProblemJson()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        for (var i = 0; i < 5; i++)
        {
            (await GetLoginAsync(client)).Should().Be(HttpStatusCode.OK, $"a tentativa {i + 1} está dentro do limite");
        }

        var response = await client.GetAsync("/api/test/login", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        response.Headers.RetryAfter.Should().NotBeNull();
        response.Headers.RetryAfter!.Delta!.Value.TotalSeconds.Should().BeGreaterThan(0);
        response.Content.Headers.ContentType?.MediaType.Should().Be("application/problem+json");
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(TestContext.Current.CancellationToken);
        problem.GetProperty("type").GetString().Should().Be("https://uniover.app/problems/rate-limited");
        problem.GetProperty("status").GetInt32().Should().Be(429);
    }

    [Fact]
    public async Task LimitIsConfigurable_FromTheRateLimitingSection()
    {
        var settings = new Dictionary<string, string?> { ["RateLimiting:login:Permitted"] = "2" };
        await using var factory = new EdgeFactory(settings: settings, withTestEndpoints: true);
        using var client = factory.CreateClient();

        (await GetLoginAsync(client)).Should().Be(HttpStatusCode.OK);
        (await GetLoginAsync(client)).Should().Be(HttpStatusCode.OK);
        (await GetLoginAsync(client)).Should().Be(HttpStatusCode.TooManyRequests);
    }

    [Fact]
    public async Task WithForwardedHeadersEnabled_DifferentClientIpsHaveIndependentPartitions()
    {
        var settings = new Dictionary<string, string?> { ["ForwardedHeaders:Enabled"] = "true" };
        await using var factory = new EdgeFactory(settings: settings, withTestEndpoints: true);
        using var client = factory.CreateClient();

        for (var i = 0; i < 5; i++)
        {
            (await GetLoginAsync(client, "203.0.113.10")).Should().Be(HttpStatusCode.OK);
        }

        (await GetLoginAsync(client, "203.0.113.10")).Should().Be(HttpStatusCode.TooManyRequests);
        (await GetLoginAsync(client, "203.0.113.11")).Should().Be(HttpStatusCode.OK, "outro IP de cliente tem o seu próprio limite");
    }

    [Fact]
    public async Task WithForwardedHeadersEnabled_TheInternalHopsOfTheProxyDoNotSplitTheClientsPartition()
    {
        // Atrás do Render, depois do cliente vêm saltos internos que mudam a cada requisição: se o limite os usasse como
        // chave, quem erra a senha sem parar nunca bateria no limite.
        var settings = new Dictionary<string, string?> { ["ForwardedHeaders:Enabled"] = "true" };
        await using var factory = new EdgeFactory(settings: settings, withTestEndpoints: true);
        using var client = factory.CreateClient();

        for (var i = 0; i < 5; i++)
        {
            (await GetLoginAsync(client, $"203.0.113.10, 10.26.16.{100 + i}")).Should().Be(HttpStatusCode.OK);
        }

        (await GetLoginAsync(client, "203.0.113.10, 10.27.0.14, 10.25.120.122")).Should().Be(
            HttpStatusCode.TooManyRequests, "o mesmo cliente por outros saltos internos cai na mesma partição");
        (await GetLoginAsync(client, "203.0.113.11, 10.26.16.100")).Should().Be(HttpStatusCode.OK, "outro cliente pelo mesmo salto tem o seu limite");
    }

    [Fact]
    public async Task WithForwardedHeadersEnabled_AForgedEntryToTheLeftOfTheClientCannotChooseThePartition()
    {
        var settings = new Dictionary<string, string?> { ["ForwardedHeaders:Enabled"] = "true" };
        await using var factory = new EdgeFactory(settings: settings, withTestEndpoints: true);
        using var client = factory.CreateClient();

        for (var i = 0; i < 5; i++)
        {
            (await GetLoginAsync(client, $"198.51.100.{i + 1}, 203.0.113.10, 10.26.16.133")).Should().Be(HttpStatusCode.OK);
        }

        (await GetLoginAsync(client, "198.51.100.200, 203.0.113.10, 10.26.16.133")).Should().Be(
            HttpStatusCode.TooManyRequests, "o que o cliente escreve antes do IP real não troca a partição");
    }

    [Fact]
    public async Task WithForwardedHeadersDisabled_TheHeaderIsIgnoredAndClientsShareOnePartition()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        for (var i = 0; i < 5; i++)
        {
            (await GetLoginAsync(client, "203.0.113.10")).Should().Be(HttpStatusCode.OK);
        }

        (await GetLoginAsync(client, "203.0.113.11")).Should().Be(HttpStatusCode.TooManyRequests,
            "sem o recurso ligado o cabeçalho forjado não pode escolher a partição");
    }
}
