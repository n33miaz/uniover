using System.Net;
using AwesomeAssertions;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Edge;

/// <summary>
/// Depois de um deploy, a casca aberta de uma versão antiga pede pedaços de código com hash que a imagem nova já não
/// tem. Esses pedidos precisam dar 404 de verdade: um <c>index.html</c> com 200 no lugar do <c>.js</c> quebra a
/// importação por tipo MIME e esconde o motivo, e o app não consegue se recuperar. As rotas do app (sem extensão)
/// continuam caindo no <c>index.html</c>.
/// </summary>
public sealed class PwaStaticAssetsTests : IAsyncLifetime
{
    private static readonly IReadOnlyDictionary<string, string?> Production = new Dictionary<string, string?>
    {
        ["ConnectionStrings:Default"] = "Host=h;Database=d;Username=u;Password=p",
    };

    private readonly string _webRoot = Path.Combine(Path.GetTempPath(), "uniover-pwa-" + Guid.NewGuid().ToString("N"));
    private EdgeFactory _factory = null!;

    public ValueTask InitializeAsync()
    {
        Directory.CreateDirectory(_webRoot);
        File.WriteAllText(
            Path.Combine(_webRoot, "index.html"),
            "<!doctype html><html lang=\"pt-BR\"><head><meta name=\"csp-nonce\" content=\"__CSP_NONCE__\"><!--uniover:manifest--></head><body></body></html>");
        File.WriteAllText(Path.Combine(_webRoot, "chunk-NOVO123.js"), "export const ok = true;");
        File.WriteAllText(Path.Combine(_webRoot, "styles-NOVO123.css"), "body{margin:0}");
        _factory = new EdgeFactory("Production", Production, webRoot: _webRoot);
        return ValueTask.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        await _factory.DisposeAsync();
        Directory.Delete(_webRoot, recursive: true);
    }

    [Theory]
    [InlineData("/chunk-ANTIGO999.js")]
    [InlineData("/main-ANTIGO999.js")]
    [InlineData("/styles-ANTIGO999.css")]
    [InlineData("/media/fonte-ANTIGA.woff2")]
    [InlineData("/chunk-ANTIGO999.js.map")]
    [InlineData("/treino/chunk-ANTIGO999.js")]
    public async Task MissingHashedAsset_Returns404_NotTheIndex(string path)
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
        response.Content.Headers.ContentType?.MediaType.Should().NotBe("text/html");
        (await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)).Should().NotContain("csp-nonce");
    }

    [Fact]
    public async Task MissingHashedAsset_Returns404_ForHeadToo()
    {
        using var client = _factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Head, "/chunk-ANTIGO999.js");

        var response = await client.SendAsync(request, TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Theory]
    [InlineData("/chunk-NOVO123.js", "javascript")]
    [InlineData("/styles-NOVO123.css", "css")]
    public async Task ExistingHashedAsset_IsServedAsTheFile(string path, string mediaTypePart)
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Content.Headers.ContentType!.MediaType.Should().Contain(mediaTypePart);
    }

    [Theory]
    [InlineData("/")]
    [InlineData("/treino")]
    [InlineData("/treino/sessao/1")]
    [InlineData("/tv/controle")]
    [InlineData("/rota-que-so-o-angular-conhece")]
    public async Task AppRoutes_StillFallBackToTheIndex(string path)
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Content.Headers.ContentType!.MediaType.Should().Be("text/html");
        (await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)).Should().Contain("csp-nonce");
    }
}
