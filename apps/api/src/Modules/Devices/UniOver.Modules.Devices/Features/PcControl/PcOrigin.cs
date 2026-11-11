using System.Globalization;
using Microsoft.AspNetCore.Http;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>
/// De onde veio o comando do PC: o código da operação (o do pedido HTTP, para ligar o registro da API ao do agente) e o aparelho do app
/// (a sessão dele, com um nome para mostrar ao dono na pergunta de aprovação). Nada daqui leva texto digitado, tecla nem coordenada.
/// </summary>
/// <param name="OperationId">O <c>X-Operation-Id</c> do pedido, ou um código novo se o app não mandou (ou mandou um inválido).</param>
/// <param name="DeviceId">A sessão do app (a família do refresh) como 32 hexadecimais; nulo sem sessão.</param>
/// <param name="DeviceName">O nome para mostrar ("iPhone (Safari)"), tirado do navegador.</param>
internal sealed record PcOrigin(string OperationId, string? DeviceId, string DeviceName);

/// <summary>Lê, do pedido que está sendo atendido, de onde veio o comando (ver <see cref="PcOrigin"/>).</summary>
internal sealed class PcOriginReader(IHttpContextAccessor accessor, ICurrentUser current)
{
    public const string OperationHeader = "X-Operation-Id";

    private const int MinOperationLength = 8;
    private const int MaxOperationLength = 40;

    public PcOrigin Read()
    {
        var http = accessor.HttpContext;
        var sent = http?.Request.Headers[OperationHeader].ToString();
        var operation = IsOperationId(sent) ? sent! : NewOperationId();
        var agent = http?.Request.Headers.UserAgent.ToString();
        return new PcOrigin(
            operation,
            current.SessionId?.ToString("N", CultureInfo.InvariantCulture),
            DeviceLabels.From(agent));
    }

    /// <summary>O formato do contrato: 8 a 40 letras, números, "_" e "-". Qualquer outra coisa (texto livre) é descartada.</summary>
    internal static bool IsOperationId(string? value) =>
        value is { Length: >= MinOperationLength and <= MaxOperationLength }
        && value.All(c => c is (>= 'A' and <= 'Z') or (>= 'a' and <= 'z') or (>= '0' and <= '9') or '_' or '-');

    internal static string NewOperationId() => Guid.CreateVersion7().ToString("N", CultureInfo.InvariantCulture)[..16];
}

/// <summary>O nome do aparelho para a pergunta ao dono ("iPhone (Safari)"), tirado do <c>User-Agent</c> sem guardar nem repassar o texto dele.</summary>
internal static class DeviceLabels
{
    public const string Unknown = "Aparelho desconhecido";

    public static string From(string? userAgent)
    {
        if (string.IsNullOrWhiteSpace(userAgent))
        {
            return Unknown;
        }

        var system = FirstOf(userAgent, ("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Windows", "Windows"), ("Macintosh", "Mac"), ("CrOS", "Chromebook"), ("Linux", "Linux"));
        var browser = FirstOf(userAgent, ("Edg/", "Edge"), ("EdgiOS", "Edge"), ("OPR/", "Opera"), ("FxiOS", "Firefox"), ("Firefox/", "Firefox"), ("CriOS", "Chrome"), ("Chrome/", "Chrome"), ("Safari/", "Safari"));
        return (system, browser) switch
        {
            (null, null) => Unknown,
            (null, _) => $"Navegador {browser}",
            (_, null) => system,
            _ => $"{system} ({browser})",
        };
    }

    private static string? FirstOf(string text, params (string Marker, string Label)[] options)
    {
        foreach (var (marker, label) in options)
        {
            if (text.Contains(marker, StringComparison.Ordinal))
            {
                return label;
            }
        }

        return null;
    }
}
