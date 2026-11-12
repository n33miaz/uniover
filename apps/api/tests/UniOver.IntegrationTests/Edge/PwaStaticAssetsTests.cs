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
        File.WriteAllText(Path.Combine(_webRoot, "chunk-NOVO1234.js"), "export const ok = true;");
        File.WriteAllText(Path.Combine(_webRoot, "styles-NOVO1234.css"), "body{margin:0}");
        File.WriteAllText(Path.Combine(_webRoot, "main-NOVO1234.js"), "export const main = true;");
        File.WriteAllText(Path.Combine(_webRoot, "chunk-B-ZYueZf.js"), "export const dash = true;");
        File.WriteAllText(Path.Combine(_webRoot, "polyfills-NOVO1234.js"), "export const poly = true;");
        // Um pedaço de uma versão anterior, que a imagem retém ao lado dos da versão atual (etapa `retained` do Dockerfile).
        File.WriteAllText(Path.Combine(_webRoot, "chunk-RETIDOA1.js"), "export const retained = true;");
        File.WriteAllText(Path.Combine(_webRoot, "main-RETIDO11.js"), "export const retainedMain = true;");
        File.WriteAllText(Path.Combine(_webRoot, "main-legacy.js"), "export const legacy = true;");
        File.WriteAllText(Path.Combine(_webRoot, "styles-legacy.css"), "body{margin:1px}");
        File.WriteAllText(Path.Combine(_webRoot, "chunk-curto.js"), "export const short = true;");
        File.WriteAllText(Path.Combine(_webRoot, "main-abcd1234.js"), "export const lower = true;");
        File.WriteAllText(Path.Combine(_webRoot, "sw.js"), "self.skipWaiting();");
        File.WriteAllText(Path.Combine(_webRoot, "boot-skeleton.js"), "document.title;");
        File.WriteAllText(Path.Combine(_webRoot, "manifest.webmanifest"), "{}");
        Directory.CreateDirectory(Path.Combine(_webRoot, "treino"));
        File.WriteAllText(Path.Combine(_webRoot, "treino", "manifest.webmanifest"), "{}");
        File.WriteAllText(Path.Combine(_webRoot, "treino", "chunk-ZZ99zz99.js"), "export const x = 1;");
        Directory.CreateDirectory(Path.Combine(_webRoot, "pc"));
        File.WriteAllText(Path.Combine(_webRoot, "pc", "manifest.webmanifest"), "{}");
        File.WriteAllText(Path.Combine(_webRoot, "chunk-ZZ99zz99.js.map"), "{}");
        File.WriteAllText(Path.Combine(_webRoot, "favicon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
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

    [Theory]
    [InlineData("/icons/sumido.png")]
    [InlineData("/exercise-art/sumido.webp")]
    [InlineData("/robots.txt")]
    [InlineData("/dados.json")]
    [InlineData("/treino/imagem-sumida.svg")]
    public async Task AnyMissingStaticFile_WithAnExtension_Returns404_NotTheIndex(string path)
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
        response.Content.Headers.ContentType?.MediaType.Should().NotBe("text/html");
    }

    [Theory]
    [InlineData("/chunk-RETIDOA1.js", "javascript")]
    [InlineData("/main-RETIDO11.js", "javascript")]
    public async Task AssetRetainedFromAPreviousVersion_IsServedImmutable_NextToTheCurrentOnes(string path, string mediaTypePart)
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Content.Headers.ContentType!.MediaType.Should().Contain(mediaTypePart);
        var cacheControl = response.Headers.CacheControl!;
        cacheControl.MaxAge.Should().Be(TimeSpan.FromDays(365));
        cacheControl.Extensions.Select(extension => extension.Name).Should().Contain("immutable");
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
    [InlineData("/chunk-NOVO1234.js", "javascript")]
    [InlineData("/styles-NOVO1234.css", "css")]
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

    [Theory]
    [InlineData("/chunk-NOVO1234.js")]
    [InlineData("/styles-NOVO1234.css")]
    [InlineData("/main-NOVO1234.js")]
    [InlineData("/polyfills-NOVO1234.js")]
    [InlineData("/chunk-B-ZYueZf.js")]
    public async Task HashedAssets_AreCachedForAYearAsImmutable(string path)
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var cacheControl = response.Headers.CacheControl!;
        cacheControl.Public.Should().BeTrue();
        cacheControl.MaxAge.Should().Be(TimeSpan.FromDays(365));
        cacheControl.NoCache.Should().BeFalse();
        cacheControl.Extensions.Select(extension => extension.Name).Should().Contain("immutable");
    }

    [Theory]
    [InlineData("/sw.js")]
    [InlineData("/boot-skeleton.js")]
    [InlineData("/manifest.webmanifest")]
    [InlineData("/treino/manifest.webmanifest")]
    [InlineData("/pc/manifest.webmanifest")]
    [InlineData("/")]
    [InlineData("/index.html")]
    [InlineData("/treino")]
    [InlineData("/pc")]
    public async Task ServiceWorker_Manifests_BootScript_AndTheIndex_MustRevalidateOnEveryUse(string path)
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.CacheControl!.NoCache.Should().BeTrue();
        response.Headers.CacheControl.MaxAge.Should().BeNull();
        response.Headers.CacheControl.ToString().Should().NotContain("immutable");
    }

    [Fact]
    public async Task OtherStaticFiles_KeepTheirDefaults_WithoutAnImmutableHeader()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/favicon.svg", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.CacheControl.Should().BeNull();
    }

    [Fact]
    public async Task AMissingHashedAsset_IsNeverCachedAsImmutable()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/chunk-ANTIGO999.js", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
        (response.Headers.CacheControl?.ToString() ?? string.Empty).Should().NotContain("immutable");
    }

    [Theory]
    [InlineData("/treino/chunk-ZZ99zz99.js")]
    [InlineData("/chunk-ZZ99zz99.js.map")]
    [InlineData("/main-legacy.js")]
    [InlineData("/styles-legacy.css")]
    [InlineData("/chunk-curto.js")]
    [InlineData("/main-abcd1234.js")]
    public async Task ALookalikeThatIsNotAnAngularHashedName_DoesNotGetAYearOfCache(string path)
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.CacheControl.Should().BeNull();
    }
}
