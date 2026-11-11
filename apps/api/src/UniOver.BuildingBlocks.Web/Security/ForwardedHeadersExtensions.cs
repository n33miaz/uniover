using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Configuration;

namespace UniOver.BuildingBlocks.Web;

public static class ForwardedHeadersExtensions
{
    /// <summary>Teto de saltos lidos da cadeia: mais que isso não é uma cadeia de proxies, é lixo.</summary>
    public const int ForwardLimit = 8;

    /// <summary>A chave de configuração com as faixas de borda a mais (lista de CIDR), somadas às embutidas.</summary>
    public const string TrustedNetworksKey = "ForwardedHeaders:TrustedNetworks";

    /// <summary>
    /// As redes que valem como "salto interno" do proxy: privadas (RFC 1918), de laço local, ULA e link-local do IPv6.
    /// São o que o Render usa entre o balanceador e o contêiner; um cliente na internet nunca tem endereço nelas.
    /// </summary>
    public static IReadOnlyList<System.Net.IPNetwork> InternalNetworks { get; } =
    [
        new(IPAddress.Parse("10.0.0.0"), 8),
        new(IPAddress.Parse("172.16.0.0"), 12),
        new(IPAddress.Parse("192.168.0.0"), 16),
        new(IPAddress.Parse("127.0.0.0"), 8),
        new(IPAddress.IPv6Loopback, 128),
        new(IPAddress.Parse("fc00::"), 7),
        new(IPAddress.Parse("fe80::"), 10),
    ];

    /// <summary>
    /// As faixas de onde a borda da Cloudflare conecta à origem, como publicadas em https://www.cloudflare.com/ips-v4 e
    /// https://www.cloudflare.com/ips-v6 (conferidas em 11/11/2026). O Render fica atrás dela, então a borda é um salto
    /// PÚBLICO da cadeia, e só UM por cadeia é descartado. Se a Cloudflare publicar uma faixa nova antes de esta lista ser atualizada, ela entra por
    /// <c>ForwardedHeaders:TrustedNetworks</c>, sem nova versão. Atenção: 172.64.0.0/13 (172.64 a 172.71) é dela e não se
    /// confunde com a privada 172.16.0.0/12 (172.16 a 172.31).
    /// </summary>
    public static IReadOnlyList<System.Net.IPNetwork> CloudflareNetworks { get; } =
    [
        System.Net.IPNetwork.Parse("173.245.48.0/20"),
        System.Net.IPNetwork.Parse("103.21.244.0/22"),
        System.Net.IPNetwork.Parse("103.22.200.0/22"),
        System.Net.IPNetwork.Parse("103.31.4.0/22"),
        System.Net.IPNetwork.Parse("141.101.64.0/18"),
        System.Net.IPNetwork.Parse("108.162.192.0/18"),
        System.Net.IPNetwork.Parse("190.93.240.0/20"),
        System.Net.IPNetwork.Parse("188.114.96.0/20"),
        System.Net.IPNetwork.Parse("197.234.240.0/22"),
        System.Net.IPNetwork.Parse("198.41.128.0/17"),
        System.Net.IPNetwork.Parse("162.158.0.0/15"),
        System.Net.IPNetwork.Parse("104.16.0.0/13"),
        System.Net.IPNetwork.Parse("104.24.0.0/14"),
        System.Net.IPNetwork.Parse("172.64.0.0/13"),
        System.Net.IPNetwork.Parse("131.0.72.0/22"),
        System.Net.IPNetwork.Parse("2400:cb00::/32"),
        System.Net.IPNetwork.Parse("2606:4700::/32"),
        System.Net.IPNetwork.Parse("2803:f800::/32"),
        System.Net.IPNetwork.Parse("2405:b500::/32"),
        System.Net.IPNetwork.Parse("2405:8100::/32"),
        System.Net.IPNetwork.Parse("2a06:98c0::/29"),
        System.Net.IPNetwork.Parse("2c0f:f248::/32"),
    ];

    /// <summary>
    /// Confia em <c>X-Forwarded-For/Proto</c> quando <c>ForwardedHeaders:Enabled</c> está ligado (padrão
    /// desligado; ligado na imagem/Render). Atrás do proxy do Render, sem isto todo cliente teria o IP do
    /// proxy e o limite de login trancaria o próprio dono.
    /// <para>
    /// O IP vira dado de auditoria (quem entrou, de onde) e chave do limite de taxa, então um cliente não pode escolhê-lo.
    /// A regra do IP é própria (<see cref="ForwardedClientIp"/>), porque a da biblioteca não expressa "no máximo uma borda":
    /// a cadeia é lida da DIREITA para a ESQUERDA; os saltos internos (<see cref="InternalNetworks"/>) são descartados;
    /// depois deles, NO MÁXIMO UM endereço de borda (<see cref="CloudflareNetworks"/> e as faixas de
    /// <c>ForwardedHeaders:TrustedNetworks</c>) é descartado; a entrada seguinte é o cliente, mesmo que também esteja em
    /// faixa da Cloudflare. Tudo que está à esquerda dele (o que o próprio cliente escreveu, forjado ou não) nunca é lido.
    /// Uma conexão direta de endereço não interno (sem o balanceador da frente) ignora o cabeçalho por inteiro.
    /// </para>
    /// <para>
    /// Medido em produção em 11/11/2026: a cadeia que chega ao contêiner é
    /// <c>&lt;o que o cliente mandou&gt;, &lt;IP real&gt;, &lt;borda da Cloudflare&gt;, &lt;10.x …&gt;</c>. Enquanto só as
    /// redes internas eram confiáveis, a leitura parava na borda (104.22.x, 104.23.x, 172.64 a 172.71): era esse o IP
    /// gravado em toda a auditoria e a chave do limite de tentativas, nunca o do usuário.
    /// </para>
    /// <para>
    /// Por que só UMA borda: quem navega por dentro da rede da Cloudflare (WARP, por exemplo) pode chegar com endereço de
    /// saída numa faixa dela. Se toda faixa da Cloudflare fosse descascada sem limite, esse endereço seria tratado como
    /// borda e valeria a entrada à esquerda, que o próprio cliente escreveu. Com o limite, o endereço que a borda viu
    /// conectar é o cliente, seja qual for a faixa.
    /// </para>
    /// <para>
    /// O teto de <see cref="ForwardLimit"/> entradas só existe para não percorrer uma cadeia gigante: depois do cliente vêm
    /// a borda e um número variável de saltos internos (10.x.x.x, que mudam a cada requisição).
    /// </para>
    /// <para>
    /// Faixas de borda a mais: <c>ForwardedHeaders:TrustedNetworks</c> é uma lista de CIDR (no ambiente,
    /// <c>ForwardedHeaders__TrustedNetworks__0</c>, <c>__1</c>…), SOMADA às da Cloudflare; nunca as substitui, e vale para
    /// elas o mesmo limite de uma borda por cadeia. Um valor inválido derruba a subida, com o valor na mensagem.
    /// </para>
    /// <para>
    /// O protocolo (<c>X-Forwarded-Proto</c>) continua com o middleware da biblioteca: vale só o último valor, e só quando
    /// quem conectou é interno.
    /// </para>
    /// <para>
    /// Risco residual: (1) quem alcançar a origem SEM passar pela Cloudflare, a partir de um endereço interno, escolhe o
    /// próprio IP; no Render isso não é possível de fora, porque o contêiner só recebe conexão do balanceador interno.
    /// (2) Tudo depende de a borda ACRESCENTAR o IP real de quem conectou; por isso o IP gravado em produção deve ser
    /// conferido com o IP público real do cliente depois de cada mudança de hospedagem. (3) Uma faixa nova da Cloudflare
    /// ainda fora da lista faz a borda aparecer como cliente (erra para o lado seguro) até entrar pela configuração.
    /// </para>
    /// </summary>
    public static IApplicationBuilder UseUniOverForwardedHeaders(this WebApplication app)
    {
        ArgumentNullException.ThrowIfNull(app);

        if (!app.Configuration.GetValue<bool>("ForwardedHeaders:Enabled"))
        {
            return app;
        }

        // O protocolo primeiro: ele confere quem conectou, e o middleware do IP troca esse endereço pelo do cliente.
        app.UseForwardedHeaders(CreateProtocolOptions());
        return app.UseMiddleware<ForwardedClientIpMiddleware>(CreateClientIp(app.Configuration));
    }

    /// <summary>A regra do IP com as faixas de borda embutidas mais as de <c>ForwardedHeaders:TrustedNetworks</c>.</summary>
    public static ForwardedClientIp CreateClientIp(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        return CreateClientIp(configuration.GetSection(TrustedNetworksKey).Get<string[]>() ?? []);
    }

    /// <summary>A regra do IP com as faixas de borda embutidas mais as dadas.</summary>
    public static ForwardedClientIp CreateClientIp(IEnumerable<string> extraEdgeNetworks)
    {
        ArgumentNullException.ThrowIfNull(extraEdgeNetworks);

        return new ForwardedClientIp(CloudflareNetworks.Concat(extraEdgeNetworks.Select(ParseTrustedNetwork)));
    }

    /// <summary>As opções do protocolo, separadas para um teste conferir a regra sem depender do valor padrão da biblioteca.</summary>
    public static ForwardedHeadersOptions CreateProtocolOptions()
    {
        var options = new ForwardedHeadersOptions
        {
            // Só o protocolo: o IP é de ForwardedClientIp. Vale o último valor, o que o salto mais próximo escreveu.
            ForwardedHeaders = ForwardedHeaders.XForwardedProto,
            ForwardLimit = 1,
        };

        // As listas NUNCA ficam vazias: vazia significa "confia em qualquer origem" e o cliente escolheria o protocolo.
        // Limpa os padrões da biblioteca só para a lista ser exatamente esta (e não mudar se a biblioteca mudar o padrão).
        options.KnownProxies.Clear();
        options.KnownIPNetworks.Clear();
        foreach (var network in InternalNetworks)
        {
            options.KnownIPNetworks.Add(network);
        }

        return options;
    }

    private static System.Net.IPNetwork ParseTrustedNetwork(string? value)
    {
        // Prefixo zero ("0.0.0.0/0", "::/0") é "qualquer endereço é borda": recusado como o inválido.
        if (!System.Net.IPNetwork.TryParse(value?.Trim(), out var network) || network.PrefixLength == 0)
        {
            throw new InvalidOperationException(
                $"{TrustedNetworksKey}: '{value}' não é uma rede válida. Use CIDR com prefixo maior que zero, como 203.0.113.0/24.");
        }

        return network;
    }
}
