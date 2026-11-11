using System.Net;
using Microsoft.AspNetCore.Http;

namespace UniOver.BuildingBlocks.Web;

/// <summary>
/// Resolve o IP do cliente a partir de quem conectou (o peer) e da cadeia de <c>X-Forwarded-For</c>. A regra, lida da
/// DIREITA para a ESQUERDA: só vale se o peer for interno; os saltos internos são descartados; depois deles, NO MÁXIMO UM
/// endereço de borda (Cloudflare ou faixa configurada) é descartado, que é a borda que conectou ao Render; a entrada
/// seguinte é o cliente, mesmo que também esteja numa faixa de borda. O middleware da biblioteca não expressa
/// "no máximo um", e com as faixas da Cloudflare confiáveis sem limite um cliente que sai por dentro da rede dela (WARP)
/// seria descascado como borda e passaria a valer a entrada à esquerda, que ele mesmo escreveu.
/// </summary>
public sealed class ForwardedClientIp
{
    private readonly IReadOnlyList<System.Net.IPNetwork> _edgeNetworks;

    public ForwardedClientIp(IEnumerable<System.Net.IPNetwork> edgeNetworks)
    {
        ArgumentNullException.ThrowIfNull(edgeNetworks);
        _edgeNetworks = [.. edgeNetworks.Distinct()];
    }

    /// <summary>As faixas de borda: a entrada logo depois dos saltos internos, se estiver nelas, é a borda e não o cliente.</summary>
    public IReadOnlyList<System.Net.IPNetwork> EdgeNetworks => _edgeNetworks;

    public static bool IsInternal(IPAddress address) => Contains(ForwardedHeadersExtensions.InternalNetworks, address);

    public bool IsEdge(IPAddress address) => Contains(_edgeNetworks, address);

    /// <summary>
    /// O IP do cliente, ou <c>null</c> quando o cabeçalho não vale (peer ausente ou não interno, ou cadeia vazia) e o IP da
    /// conexão deve ficar como está. <paramref name="chain"/> são as entradas na ordem do cabeçalho.
    /// </summary>
    public IPAddress? Resolve(IPAddress? peer, IReadOnlyList<string> chain)
    {
        ArgumentNullException.ThrowIfNull(chain);

        // Conexão direta de endereço não interno (sem o balanceador da frente): o cabeçalho é do cliente e não vale nada.
        if (peer is null || !IsInternal(Normalize(peer)))
        {
            return null;
        }

        IPAddress? resolved = null;
        var lowest = Math.Max(0, chain.Count - ForwardedHeadersExtensions.ForwardLimit);
        var edgeSeen = false;
        for (var i = chain.Count - 1; i >= lowest; i--)
        {
            // A leitura para no que não é endereço; nada à esquerda é lido.
            if (!TryParse(chain[i], out var address))
            {
                break;
            }

            resolved = address;
            if (edgeSeen)
            {
                // Quem a borda viu conectar: é o cliente, seja qual for a faixa dele.
                break;
            }

            if (IsInternal(address))
            {
                continue;
            }

            if (!IsEdge(address))
            {
                break;
            }

            edgeSeen = true;
        }

        return resolved;
    }

    private static bool TryParse(string entry, out IPAddress address)
    {
        // Aceita "ip" e "ip:porta" (e "[v6]:porta"), como a biblioteca.
        if (IPEndPoint.TryParse(entry.AsSpan().Trim(), out var endpoint))
        {
            address = Normalize(endpoint.Address);
            return true;
        }

        address = IPAddress.None;
        return false;
    }

    private static IPAddress Normalize(IPAddress address) => address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address;

    private static bool Contains(IReadOnlyList<System.Net.IPNetwork> networks, IPAddress address)
    {
        foreach (var network in networks)
        {
            if (network.Contains(address))
            {
                return true;
            }
        }

        return false;
    }
}

/// <summary>Troca o IP da conexão pelo que <see cref="ForwardedClientIp"/> resolve; sem resolução, a conexão fica como está.</summary>
public sealed class ForwardedClientIpMiddleware(RequestDelegate next, ForwardedClientIp resolver)
{
    public Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        var chain = context.Request.Headers.GetCommaSeparatedValues("X-Forwarded-For");
        if (chain.Length > 0 && resolver.Resolve(context.Connection.RemoteIpAddress, chain) is { } client)
        {
            context.Connection.RemoteIpAddress = client;
            context.Connection.RemotePort = 0;
        }

        return next(context);
    }
}
