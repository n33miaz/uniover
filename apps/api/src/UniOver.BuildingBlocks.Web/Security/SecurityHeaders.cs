using System.Security.Cryptography;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace UniOver.BuildingBlocks.Web;

/// <summary>Nonce de CSP da requisição atual (um por requisição, mesmo valor no cabeçalho e no HTML).</summary>
public interface ICspNonce
{
    string Value { get; }
}

internal sealed class CspNonce : ICspNonce
{
    // 16 bytes aleatórios em base64: imprevisível e curto o bastante para o cabeçalho.
    private readonly Lazy<string> _value = new(() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)));

    public string Value => _value.Value;
}

public sealed class SecurityHeadersOptions
{
    public const string NoncePlaceholder = "{nonce}";

    /// <summary>Sem <c>unsafe-inline</c> em nenhuma diretiva; estilos só por nonce.</summary>
    public string ContentSecurityPolicy { get; set; } =
        "default-src 'self'; script-src 'self'; style-src 'self' 'nonce-{nonce}'; img-src 'self' data:; "
        + "font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; "
        + "base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

    public string PermissionsPolicy { get; set; } =
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()";

    public int HstsMaxAgeSeconds { get; set; } = 31536000;
}

internal sealed class SecurityHeadersMiddleware(
    RequestDelegate next,
    IOptions<SecurityHeadersOptions> options,
    IHostEnvironment environment)
{
    public Task InvokeAsync(HttpContext context)
    {
        var settings = options.Value;
        var hsts = environment.IsDevelopment()
            ? null
            : $"max-age={settings.HstsMaxAgeSeconds}; includeSubDomains";

        // OnStarting em vez de escrever agora: o tratador de exceção limpa os cabeçalhos da resposta, e assim
        // a resposta final (inclusive a de erro) sempre sai protegida.
        context.Response.OnStarting(() =>
        {
            var headers = context.Response.Headers;
            var nonce = context.RequestServices.GetRequiredService<ICspNonce>().Value;

            headers.ContentSecurityPolicy = settings.ContentSecurityPolicy.Replace(
                SecurityHeadersOptions.NoncePlaceholder, nonce, StringComparison.Ordinal);
            headers.XContentTypeOptions = "nosniff";
            headers["Referrer-Policy"] = "no-referrer";
            headers["Permissions-Policy"] = settings.PermissionsPolicy;
            headers["Cross-Origin-Opener-Policy"] = "same-origin";
            if (hsts is not null)
            {
                headers.StrictTransportSecurity = hsts;
            }

            if (context.Request.Path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase))
            {
                headers.CacheControl = "no-store";
            }

            return Task.CompletedTask;
        });

        return next(context);
    }
}

public static class SecurityHeadersExtensions
{
    public static IServiceCollection AddUniOverSecurityHeaders(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        services.AddOptions<SecurityHeadersOptions>().Bind(configuration.GetSection("SecurityHeaders"));
        services.AddScoped<ICspNonce, CspNonce>();
        return services;
    }

    /// <summary>Cabeçalhos de segurança em toda resposta. Sem CORS: o PWA e a API são da mesma origem.</summary>
    public static IApplicationBuilder UseUniOverSecurityHeaders(this IApplicationBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        return app.UseMiddleware<SecurityHeadersMiddleware>();
    }
}
