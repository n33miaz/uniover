using System.Reflection;
using System.Text.Json;

namespace UniOver.BuildingBlocks.Web;

/// <summary>
/// As versões informativas por módulo, lidas do <c>modules.json</c> da raiz do repositório (a esteira de publicação as sobe
/// por módulo, mas o deploy segue sendo um serviço só). O arquivo viaja dentro do assembly, como os esquemas do agente.
/// </summary>
public static class ModuleVersions
{
    internal const string ResourceName = "modules.json";

    /// <summary>Módulo para versão, na ordem do arquivo. Vazio se o recurso não existir ou não for JSON; entrada que não é texto é ignorada.</summary>
    public static IReadOnlyDictionary<string, string> Load()
    {
        using var stream = typeof(ModuleVersions).Assembly.GetManifestResourceStream(ResourceName);
        return stream is null ? new Dictionary<string, string>() : Parse(stream);
    }

    internal static Dictionary<string, string> Parse(Stream json)
    {
        var versions = new Dictionary<string, string>();
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json);
        }
        catch (JsonException)
        {
            // Um arquivo informativo quebrado não derruba o Host: a lista sai vazia e o --verify da esteira acusa o erro.
            return versions;
        }

        using var _ = document;
        if (document.RootElement.ValueKind != JsonValueKind.Object)
        {
            return versions;
        }

        foreach (var property in document.RootElement.EnumerateObject())
        {
            if (property.Value.ValueKind == JsonValueKind.String && property.Value.GetString() is { Length: > 0 } version)
            {
                versions[property.Name] = version;
            }
        }

        return versions;
    }
}
