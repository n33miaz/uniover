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
    /// </summary>
    public static IApplicationBuilder UseUniOverForwardedHeaders(this WebApplication app)
    {
        ArgumentNullException.ThrowIfNull(app);

        if (!app.Configuration.GetValue<bool>("ForwardedHeaders:Enabled"))
        {
            return app;
        }

        var options = new ForwardedHeadersOptions
        {
            ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
        };
        options.KnownIPNetworks.Clear();
        options.KnownProxies.Clear();
        return app.UseForwardedHeaders(options);
    }
}
