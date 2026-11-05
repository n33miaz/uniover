using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using AwesomeAssertions;
using UniOver.IntegrationTests.AgentProtocol;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Edge;

/// <summary>
/// O servidor grava em <c>&lt;html data-boot&gt;</c> o esqueleto de abertura do endereço, para o primeiro quadro já
/// ter o desenho certo. A regra é a mesma do <c>boot-skeleton.js</c> e do <c>boot-variant.ts</c>: os três são
/// conferidos contra <c>contracts/boot-variants.json</c>.
/// </summary>
public partial class BootVariantTests
{
    [GeneratedRegex(@"<html[^>]*\sdata-boot=""(?<v>[^""]*)""")]
    private static partial Regex HtmlBoot();

    private static List<(string Path, string Variant)> Table()
    {
        var file = Path.Combine(OpenApiContractTests.RepositoryRoot(), "contracts", "boot-variants.json");
        using var document = JsonDocument.Parse(File.ReadAllText(file));
        return document.RootElement.GetProperty("cases").EnumerateArray()
            .Select(item => (item.GetProperty("path").GetString()!, item.GetProperty("variant").GetString()!))
            .ToList();
    }

    [Fact]
    public async Task IndexHtml_CarriesTheBootVariantOfEveryPathInTheSharedTable()
    {
        await using var factory = new EdgeFactory();
        using var client = factory.CreateClient();

        foreach (var (path, variant) in Table())
        {
            var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

            response.StatusCode.Should().Be(HttpStatusCode.OK, path);
            var html = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
            HtmlBoot().Match(html).Groups["v"].Value.Should().Be(variant, path);
            Regex.Matches(html, "data-boot=").Should().HaveCount(1, path);
        }
    }

    [Theory]
    [InlineData("/tv", "tv")]
    [InlineData("/treino", "training-today")]
    [InlineData("/treino/rotinas", "training-routines")]
    [InlineData("/treino/exercicios/abc", "training-exercise-detail")]
    public async Task BootVariant_DoesNotDisturbTheNonceNorTheManifest(string path, string variant)
    {
        await using var factory = new EdgeFactory();
        using var client = factory.CreateClient();

        var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

        var nonce = Regex.Match(
            response.Headers.GetValues("Content-Security-Policy").Single(), "'nonce-(?<n>[^']+)'").Groups["n"].Value;
        var html = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        html.Should().Contain($"data-boot=\"{variant}\"").And.Contain($"content=\"{nonce}\"");
        html.Should().NotContain("__CSP_NONCE__").And.NotContain("<!--uniover:manifest-->").And.Contain("rel=\"manifest\"");
    }
}
