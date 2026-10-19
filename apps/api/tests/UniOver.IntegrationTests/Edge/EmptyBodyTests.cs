using System.Net;
using System.Text;
using AwesomeAssertions;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Edge;

/// <summary>
/// Corpo ausente ou sem <c>Content-Type</c> nunca pode cair no 404 de <c>/api/{**path}</c>: o fallback só vale
/// para rota que não existe.
/// </summary>
public class EmptyBodyTests
{
    private static async Task<HttpResponseMessage> PostAsync(HttpClient client, string url, string? json)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        if (json is not null)
        {
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        }

        return await client.SendAsync(request, TestContext.Current.CancellationToken);
    }

    /// <summary>Corpo presente, mas sem cabeçalho <c>Content-Type</c>.</summary>
    private static async Task<HttpResponseMessage> PostWithoutContentTypeAsync(HttpClient client, string url)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new ByteArrayContent(Encoding.UTF8.GetBytes("{\"name\":\"x\"}")),
        };
        return await client.SendAsync(request, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task OptionalBody_WithoutContentType_Executes()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        using var response = await PostAsync(client, "/api/test/optional-body", json: null);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task OptionalBody_Present_ButWithoutContentType_Returns415()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        using var response = await PostWithoutContentTypeAsync(client, "/api/test/optional-body");

        response.StatusCode.Should().Be(HttpStatusCode.UnsupportedMediaType);
    }

    [Fact]
    public async Task OptionalBody_WithJson_Executes()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        using var response = await PostAsync(client, "/api/test/optional-body", "{\"name\":\"x\"}");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task RequiredBody_WithoutContentType_Returns415()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        using var response = await PostWithoutContentTypeAsync(client, "/api/test/required-body");

        response.StatusCode.Should().Be(HttpStatusCode.UnsupportedMediaType);
    }

    [Fact]
    public async Task RequiredBody_WithJson_Executes()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        using var response = await PostAsync(client, "/api/test/required-body", "{\"name\":\"x\"}");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task RequiredBody_WithoutContentType_AnswersAsProblemJson()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        using var response = await PostWithoutContentTypeAsync(client, "/api/test/required-body");

        response.Content.Headers.ContentType?.MediaType.Should().Be("application/problem+json");
    }

    [Fact]
    public async Task MalformedJson_Returns400_NotServerError()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        using var response = await PostAsync(client, "/api/test/required-body", "{nao-e-json");

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task UnknownApiRoute_Get_StillReturns404()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        using var response = await client.GetAsync("/api/v1/nao-existe", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task UnknownApiRoute_Post_NeverServesTheApp()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        using var response = await PostAsync(client, "/api/v1/nao-existe", "{}");

        // Só GET/HEAD navegam: qualquer outro método numa rota desconhecida é recusado como erro, nunca 200 com HTML.
        ((int)response.StatusCode).Should().BeGreaterThanOrEqualTo(400);
        response.Content.Headers.ContentType?.MediaType.Should().Be("application/problem+json");
    }

    [Fact]
    public async Task RequiredBody_Empty_Returns400_NeverTheApiFallback()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        using var response = await PostAsync(client, "/api/test/required-body", json: null);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
