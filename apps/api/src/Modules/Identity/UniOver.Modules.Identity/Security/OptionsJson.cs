using System.Text.Json;

namespace UniOver.Modules.Identity.Security;

/// <summary>Opções do WebAuthn guardadas como texto, devolvidas ao cliente como JSON de verdade (não como string escapada).</summary>
internal static class OptionsJson
{
    public static JsonElement Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }
}
