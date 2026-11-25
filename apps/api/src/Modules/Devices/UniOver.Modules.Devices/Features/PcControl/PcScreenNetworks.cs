using System.Net;
using Microsoft.Extensions.Configuration;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>
/// As redes de onde a tela do PC aceita uma oferta, por configuração (<c>Modules:Devices:PcScreen:AllowedNetworks</c>, uma lista de
/// CIDR; no ambiente, <c>Modules__Devices__PcScreen__AllowedNetworks__0</c>, <c>__1</c>…). Serve para ver a tela fora de casa por uma
/// VPN, por exemplo a faixa CGNAT do Tailscale (<c>100.64.0.0/10</c>).
/// <list type="bullet">
/// <item>Sem a chave (ou vazia): nenhuma checagem de rede é feita e o comportamento é o de sempre.</item>
/// <item>Com ela: a oferta só vale se o IP do cliente estiver numa das faixas ou numa rede interna (casa).</item>
/// <item>Uma entrada inválida não derruba a subida e nunca abre mais do que o configurado: ela é ignorada, e a lista continua
/// valendo como definida (uma lista só de entradas inválidas aceita apenas as redes internas).</item>
/// </list>
/// A flag <c>pc_screen</c>, a permissão e a aprovação do aparelho continuam valendo; esta checagem só se soma a elas.
/// </summary>
internal sealed class PcScreenNetworks
{
    public const string ConfigurationKey = "Modules:Devices:PcScreen:AllowedNetworks";

    private readonly IReadOnlyList<System.Net.IPNetwork> _networks;

    public PcScreenNetworks(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        var entries = (configuration.GetSection(ConfigurationKey).Get<string[]>() ?? [])
            .Where(entry => !string.IsNullOrWhiteSpace(entry))
            .ToList();
        Configured = entries.Count > 0;
        _networks = [.. entries.Select(entry => System.Net.IPNetwork.TryParse(entry.Trim(), out var network) ? network : (System.Net.IPNetwork?)null)
            .OfType<System.Net.IPNetwork>()];
    }

    /// <summary>Há uma lista configurada; sem ela a checagem não existe.</summary>
    public bool Configured { get; }

    /// <summary>A oferta pode vir deste endereço? Sempre que não há lista; com lista, só de dentro dela ou de uma rede interna.</summary>
    public bool Allows(string? clientIp)
    {
        if (!Configured)
        {
            return true;
        }

        if (!IPAddress.TryParse(clientIp, out var address))
        {
            return false;
        }

        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        return ForwardedClientIp.IsInternal(address) || _networks.Any(network => network.Contains(address));
    }
}
