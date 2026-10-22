using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Configuration;

namespace UniOver.BuildingBlocks.Web;

public static class ForwardedHeadersExtensions
{
    /// <summary>Teto de saltos lidos da cadeia: mais que isso não é uma cadeia de proxies, é lixo.</summary>
    public const int ForwardLimit = 8;

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
    /// Confia em <c>X-Forwarded-For/Proto</c> quando <c>ForwardedHeaders:Enabled</c> está ligado (padrão
    /// desligado; ligado na imagem/Render). Atrás do proxy do Render, sem isto todo cliente teria o IP do
    /// proxy e o limite de login trancaria o próprio dono.
    /// <para>
    /// O IP vira dado de auditoria (quem entrou, de onde) e chave do limite de taxa, então um cliente não pode escolhê-lo.
    /// A regra é a da biblioteca, com as redes internas (<see cref="InternalNetworks"/>) como únicos proxies confiáveis: a
    /// cadeia é lida da DIREITA para a ESQUERDA, e cada salto é "descascado" enquanto quem o entregou for um endereço
    /// interno; a leitura PARA no primeiro endereço público, e esse é o cliente. Tudo que está à esquerda dele (o que o
    /// próprio cliente escreveu, forjado ou não) nunca é lido. Uma conexão direta de endereço público (sem proxy da frente)
    /// não é confiável e o cabeçalho é ignorado por inteiro.
    /// </para>
    /// <para>
    /// Por que não é mais <c>ForwardLimit = 1</c> (só a última entrada): o Render coloca DEPOIS do cliente um número variável
    /// de saltos internos (10.x.x.x, que mudam a cada requisição). Com o limite de 1 o IP auditado e a partição do limite de
    /// taxa eram o do último salto, e não o do cliente. O teto de <see cref="ForwardLimit"/> só existe para não
    /// percorrer uma cadeia gigante.
    /// </para>
    /// <para>
    /// Risco residual: isto depende de o proxy da frente ACRESCENTAR o IP real de quem conectou à cadeia. Se ele não
    /// acrescentasse, o primeiro endereço público à esquerda dos saltos internos seria o que o cliente escreveu e poderia
    /// ser forjado. Por isso o IP gravado em produção deve ser conferido com o IP público real do cliente depois de cada
    /// mudança de hospedagem.
    /// </para>
    /// </summary>
    public static IApplicationBuilder UseUniOverForwardedHeaders(this WebApplication app)
    {
        ArgumentNullException.ThrowIfNull(app);

        if (!app.Configuration.GetValue<bool>("ForwardedHeaders:Enabled"))
        {
            return app;
        }

        return app.UseForwardedHeaders(CreateOptions());
    }

    /// <summary>As opções de confiança, separadas para um teste conferir a regra sem depender do valor padrão da biblioteca.</summary>
    public static ForwardedHeadersOptions CreateOptions()
    {
        var options = new ForwardedHeadersOptions
        {
            ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
            ForwardLimit = ForwardLimit,

            // O Render põe saltos internos de número variável, e o proxy nem sempre repete o cabeçalho de protocolo por salto.
            RequireHeaderSymmetry = false,
        };

        // As listas NUNCA ficam vazias: vazia significa "confia em qualquer origem" e o cliente escolheria o próprio IP.
        // Limpa os padrões da biblioteca só para a lista ser exatamente esta (e não mudar se a biblioteca mudar o padrão).
        options.KnownProxies.Clear();
        options.KnownIPNetworks.Clear();
        foreach (var network in InternalNetworks)
        {
            options.KnownIPNetworks.Add(network);
        }

        return options;
    }
}
