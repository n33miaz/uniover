using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Configuration;

namespace UniOver.BuildingBlocks.Web;

public static class ForwardedHeadersExtensions
{
    /// <summary>
    /// Confia em <c>X-Forwarded-For/Proto</c> quando <c>ForwardedHeaders:Enabled</c> está ligado (padrão
    /// desligado; ligado na imagem/Render). Atrás do proxy do Render, sem isto todo cliente teria o IP do
    /// proxy e o limite de login trancaria o próprio dono. Ligado só onde a instância é alcançável apenas pelo
    /// proxy, por isso as listas de proxies conhecidos ficam vazias (aceita qualquer origem).
    /// <para>
    /// O IP vira dado de auditoria (quem entrou, de onde), então só vale o que o PROXY acrescentou: o limite de
    /// <c>1</c> faz o middleware ler uma única entrada, a ÚLTIMA (a mais à direita, que o proxy da frente escreveu), e
    /// ignorar tudo que o cliente mandou antes dela. Um cliente que envie <c>X-Forwarded-For: 6.6.6.6</c> chega como
    /// <c>6.6.6.6, &lt;IP real&gt;</c> e o IP auditado é o real.
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

    /// <summary>As opções de confiança, separadas para um teste conferir o limite sem depender do valor padrão da biblioteca.</summary>
    public static ForwardedHeadersOptions CreateOptions()
    {
        var options = new ForwardedHeadersOptions
        {
            ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,

            // Explícito: é o padrão da biblioteca, mas a segurança do IP auditado depende dele e não pode mudar em silêncio.
            ForwardLimit = 1,
        };
        options.KnownIPNetworks.Clear();
        options.KnownProxies.Clear();
        return options;
    }
}
