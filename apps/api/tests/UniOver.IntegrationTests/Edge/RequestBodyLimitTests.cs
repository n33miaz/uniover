using System.Net;
using System.Text;
using AwesomeAssertions;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Edge;

/// <summary>
/// Teto de corpo para toda rota: login, refresh, pareamento e convite leem JSON, e o padrão do Kestrel (28,6 MB) é
/// grande demais para um serviço de 512 MB. A rota de foto e a de importação declaram o próprio teto.
/// </summary>
public class RequestBodyLimitTests
{
    private const string Route = "/api/test/required-body";

    private static StringContent Json(int bytes) =>
        new("{\"name\":\"" + new string('a', bytes) + "\"}", Encoding.UTF8, "application/json");

    private static async Task<HttpResponseMessage> PostAsync(HttpClient client, HttpContent content)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, Route) { Content = content };
        return await client.SendAsync(request, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task ABodyUnderTheCap_PassesAndOneOverItIs413_WithAProblemBody()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        using var small = await PostAsync(client, Json(200 * 1024));
        using var large = await PostAsync(client, Json(300 * 1024));

        small.StatusCode.Should().Be(HttpStatusCode.OK);
        large.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);
        large.Content.Headers.ContentType?.MediaType.Should().Be("application/problem+json");
        (await large.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)).Should().Contain("payload-too-large");
    }

    [Fact]
    public async Task ABodyWithoutDeclaredLength_IsStoppedAtTheCap_Too()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        using var response = await PostAsync(client, new ChunkedContent(300 * 1024));

        response.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);
    }

    [Fact]
    public async Task TheCapIsConfigurable()
    {
        var settings = new Dictionary<string, string?> { ["RequestLimits:MaxBodyBytes"] = "2048" };
        await using var factory = new EdgeFactory(settings: settings, withTestEndpoints: true);
        using var client = factory.CreateClient();

        using var small = await PostAsync(client, Json(1000));
        using var large = await PostAsync(client, Json(3000));

        small.StatusCode.Should().Be(HttpStatusCode.OK);
        large.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);
    }

    [Fact]
    public async Task TheCap_AppliesToTheRealAnonymousRoutes()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        // Login: o corpo grande é recusado antes de qualquer leitura (e sem tocar no banco, que nem está configurado).
        using var response = await PostAsync(client, Json(1024 * 1024), "/api/v1/identity/auth/login");

        response.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);
    }

    private static async Task<HttpResponseMessage> PostAsync(HttpClient client, HttpContent content, string route)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, route) { Content = content };
        return await client.SendAsync(request, TestContext.Current.CancellationToken);
    }

    /// <summary>Corpo sem <c>Content-Length</c> (vai com <c>Transfer-Encoding: chunked</c>).</summary>
    private sealed class ChunkedContent(int size) : HttpContent
    {
        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context)
        {
            var prefix = Encoding.UTF8.GetBytes("{\"name\":\"");
            await stream.WriteAsync(prefix);
            var block = Encoding.UTF8.GetBytes(new string('a', 4096));
            for (var written = 0; written < size; written += block.Length)
            {
                await stream.WriteAsync(block);
            }

            await stream.WriteAsync(Encoding.UTF8.GetBytes("\"}"));
        }

        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
    }
}
