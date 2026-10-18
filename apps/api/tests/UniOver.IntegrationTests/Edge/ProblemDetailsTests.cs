using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AwesomeAssertions;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Edge;

public class ProblemDetailsTests
{
    private static async Task<JsonElement> ReadProblemAsync(HttpResponseMessage response)
    {
        response.Content.Headers.ContentType?.MediaType.Should().Be("application/problem+json");
        return await response.Content.ReadFromJsonAsync<JsonElement>(TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task UnknownApiRoute_Returns404AsProblemJson()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/api/v1/nao-existe", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
        var problem = await ReadProblemAsync(response);
        problem.GetProperty("status").GetInt32().Should().Be(404);
        problem.GetProperty("type").GetString().Should().Be("https://uniover.app/problems/not-found");
        problem.TryGetProperty("traceId", out _).Should().BeTrue();
    }

    [Fact]
    public async Task ValidationFailure_Returns400WithErrorsPerField()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/api/test/validation", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var problem = await ReadProblemAsync(response);
        problem.GetProperty("type").GetString().Should().Be("https://uniover.app/problems/validation-failed");
        problem.GetProperty("errors").GetProperty("email")[0].GetString().Should().Be("Informe um e-mail válido.");
    }

    [Fact]
    public async Task UnhandledException_InProduction_Returns500WithoutInternalDetail()
    {
        await using var factory = new EdgeFactory("Production", new Dictionary<string, string?> { ["ConnectionStrings:Default"] = "Host=h;Database=d;Username=u;Password=p" }, withTestEndpoints: true);
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/api/test/boom", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.InternalServerError);
        var body = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        body.Should().NotContain("detalhe-interno-secreto");
        body.Should().NotContain("   at ");
        var problem = await ReadProblemAsync(response);
        problem.TryGetProperty("detail", out _).Should().BeFalse();
        problem.GetProperty("type").GetString().Should().Be("https://uniover.app/problems/internal-error");
        response.Headers.Contains("X-Content-Type-Options").Should().BeTrue("a resposta de erro também sai protegida");
    }

    [Fact]
    public async Task MethodNotAllowed_Returns405AsProblemJson()
    {
        await using var factory = new EdgeFactory(withTestEndpoints: true);
        using var client = factory.CreateClient();

        var response = await client.PostAsync("/", content: null, TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.MethodNotAllowed);
        (await ReadProblemAsync(response)).GetProperty("type").GetString()
            .Should().Be("https://uniover.app/problems/method-not-allowed");
    }
}
