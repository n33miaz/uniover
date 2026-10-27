using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.AgentProtocol;

/// <summary>
/// Gera o documento OpenAPI do Host real e o compara com o versionado em <c>contracts/http/openapi.json</c>.
/// Com <c>UNIOVER_UPDATE_CONTRACTS=1</c> grava o arquivo em vez de comparar; <c>UNIOVER_OPENAPI_OUTPUT</c>
/// troca o destino (a checagem da esteira grava numa pasta temporária e compara por fora).
/// </summary>
public class OpenApiContractTests
{
    private const string UpdateVariable = "UNIOVER_UPDATE_CONTRACTS";
    private const string OutputVariable = "UNIOVER_OPENAPI_OUTPUT";

    [Fact]
    public async Task OpenApiDocument_MatchesTheVersionedContract()
    {
        await using var factory = new EdgeFactory("Development");
        using var client = factory.CreateClient();
        var raw = await client.GetStringAsync("/openapi/v1.json", TestContext.Current.CancellationToken);
        var generated = Normalize(raw);

        var output = Environment.GetEnvironmentVariable(OutputVariable);
        var update = Environment.GetEnvironmentVariable(UpdateVariable) == "1";
        var target = string.IsNullOrWhiteSpace(output)
            ? Path.Combine(RepositoryRoot(), "contracts", "http", "openapi.json")
            : output;

        if (update || !string.IsNullOrWhiteSpace(output))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(target))!);
            await File.WriteAllTextAsync(target, generated, new UTF8Encoding(false), TestContext.Current.CancellationToken);
            return;
        }

        var committed = (await File.ReadAllTextAsync(target, TestContext.Current.CancellationToken)).Replace("\r\n", "\n", StringComparison.Ordinal);
        committed.Should().Be(generated, "o OpenAPI versionado deve refletir a API; rode `npm --prefix contracts run generate`");
    }

    [Fact]
    public async Task IdempotencyOperation_DeclaresTheOptionalHeaderAndItsProblemResponses()
    {
        await using var factory = new EdgeFactory("Development");
        using var client = factory.CreateClient();
        var document = JsonNode.Parse(await client.GetStringAsync("/openapi/v1.json", TestContext.Current.CancellationToken))!;
        var operation = document["paths"]!["/api/v1/identity/me"]!["patch"]!.AsObject();

        var header = operation["parameters"]!.AsArray()
            .Select(parameter => parameter!.AsObject())
            .Single(parameter => parameter["name"]?.GetValue<string>() == "Idempotency-Key");

        header["in"]!.GetValue<string>().Should().Be("header");
        (header["required"]?.GetValue<bool>() ?? false).Should().BeFalse();
        operation["responses"]!.AsObject().Should().ContainKeys("409", "422");
    }

    /// <summary>Saída determinística: chaves ordenadas, sem servidores (dependem do host), versão fixa e LF.</summary>
    private static string Normalize(string json)
    {
        var node = JsonNode.Parse(json)!.AsObject();
        node.Remove("servers");
        node["info"]!["version"] = "1.0.0";
        var sorted = Sort(node);
        var text = sorted!.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
        return text.Replace("\r\n", "\n", StringComparison.Ordinal) + "\n";
    }

    private static JsonNode? Sort(JsonNode? node) => node switch
    {
        JsonObject obj => new JsonObject(obj
            .OrderBy(p => p.Key, StringComparer.Ordinal)
            .Select(p => KeyValuePair.Create(p.Key, Sort(p.Value)))),
        JsonArray array => new JsonArray(array.Select(Sort).ToArray()),
        _ => node?.DeepClone(),
    };

    internal static string RepositoryRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "contracts", "agent")))
        {
            dir = dir.Parent;
        }

        return dir?.FullName ?? throw new InvalidOperationException("Raiz do repositório não encontrada.");
    }
}
