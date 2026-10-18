using System.Net;
using System.Text.RegularExpressions;
using AwesomeAssertions;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Edge;

public partial class SecurityHeadersAndPwaTests
{
    private static readonly IReadOnlyDictionary<string, string?> Production = new Dictionary<string, string?>
    {
        ["ConnectionStrings:Default"] = "Host=h;Database=d;Username=u;Password=p",
    };

    [GeneratedRegex("'nonce-(?<n>[^']+)'")]
    private static partial Regex NonceInCsp();

    private static string CspNonceOf(HttpResponseMessage response) =>
        NonceInCsp().Match(response.Headers.GetValues("Content-Security-Policy").Single()).Groups["n"].Value;

    [Theory]
    [InlineData("/health/live")]
    [InlineData("/")]
    public async Task Responses_CarryAllSecurityHeaders_AndCspHasNoUnsafeInline(string path)
    {
        await using var factory = new EdgeFactory();
        using var client = factory.CreateClient();

        var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var csp = response.Headers.GetValues("Content-Security-Policy").Single();
        csp.Should().NotContain("unsafe-inline");
        csp.Should().Contain("default-src 'self'").And.Contain("frame-ancestors 'none'").And.Contain("object-src 'none'");
        response.Headers.GetValues("X-Content-Type-Options").Single().Should().Be("nosniff");
        response.Headers.GetValues("Referrer-Policy").Single().Should().Be("no-referrer");
        response.Headers.GetValues("Permissions-Policy").Single().Should().Contain("camera=()");
        response.Headers.GetValues("Cross-Origin-Opener-Policy").Single().Should().Be("same-origin");
        response.Headers.Contains("Access-Control-Allow-Origin").Should().BeFalse("não há CORS: a origem é a mesma");
    }

    [Fact]
    public async Task Hsts_IsAbsentInDevelopment_AndPresentInProduction()
    {
        await using var development = new EdgeFactory("Development");
        await using var production = new EdgeFactory("Production", Production);
        using var devClient = development.CreateClient();
        using var prodClient = production.CreateClient();

        var dev = await devClient.GetAsync("/health/live", TestContext.Current.CancellationToken);
        var prod = await prodClient.GetAsync("/health/live", TestContext.Current.CancellationToken);

        dev.Headers.Contains("Strict-Transport-Security").Should().BeFalse();
        prod.Headers.GetValues("Strict-Transport-Security").Single().Should().Be("max-age=31536000; includeSubDomains");
    }

    [Fact]
    public async Task ApiResponses_AreNotCached()
    {
        await using var factory = new EdgeFactory();
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/api/v1/tv/info", TestContext.Current.CancellationToken);

        response.Headers.CacheControl!.NoStore.Should().BeTrue();
    }

    [Theory]
    [InlineData("/")]
    [InlineData("/index.html")]
    [InlineData("/INDEX.HTML")]
    [InlineData("/treino/sessao/1")]
    public async Task IndexHtml_IsServedWithTheHeaderNonceAndNeverRaw(string path)
    {
        await using var factory = new EdgeFactory();
        using var client = factory.CreateClient();

        var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var nonce = CspNonceOf(response);
        nonce.Should().NotBeNullOrEmpty();
        var html = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        html.Should().Contain($"content=\"{nonce}\"");
        html.Should().NotContain("__CSP_NONCE__").And.NotContain("<!--uniover:manifest-->");
        response.Headers.CacheControl!.NoCache.Should().BeTrue();
    }

    [Fact]
    public async Task Nonce_ChangesOnEveryRequest()
    {
        await using var factory = new EdgeFactory();
        using var client = factory.CreateClient();

        var first = await client.GetAsync("/", TestContext.Current.CancellationToken);
        var second = await client.GetAsync("/", TestContext.Current.CancellationToken);

        CspNonceOf(first).Should().NotBe(CspNonceOf(second));
    }

    [Theory]
    [InlineData("/tv/controle", "/tv/manifest.webmanifest", "/tv/apple-touch-icon.png")]
    [InlineData("/treino", "/treino/manifest.webmanifest", "/treino/apple-touch-icon.png")]
    [InlineData("/outro/lugar", "href=\"/manifest.webmanifest\"", "href=\"/apple-touch-icon.png\"")]
    [InlineData("/", "href=\"/manifest.webmanifest\"", "href=\"/apple-touch-icon.png\"")]
    public async Task Manifest_IsChosenPerModuleOnTheServer(string path, string manifest, string icon)
    {
        await using var factory = new EdgeFactory();
        using var client = factory.CreateClient();

        var html = await client.GetStringAsync(path, TestContext.Current.CancellationToken);

        html.Should().Contain(manifest).And.Contain(icon);
        Regex.Matches(html, "rel=\"manifest\"").Should().HaveCount(1);
    }

    [Theory]
    [InlineData("/api/v1/qualquer")]
    [InlineData("/health/outro")]
    [InlineData("/openapi/v1.json")]
    [InlineData("/arquivo-que-nao-existe.js")]
    public async Task ReservedPrefixesAndMissingFiles_Return404_NotTheIndex(string path)
    {
        await using var factory = new EdgeFactory("Production", Production);
        using var client = factory.CreateClient();

        var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }
}
