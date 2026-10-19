using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;

namespace UniOver.BuildingBlocks.Web;

public sealed class PwaOptions
{
    /// <summary>Slugs de módulo que têm manifest próprio (<c>/&lt;slug&gt;/manifest.webmanifest</c>).</summary>
    public List<string> Modules { get; set; } = [];
}

/// <summary>
/// Esconde o <c>index.html</c> cru do servidor de arquivos estáticos: ele contém marcadores que só o endpoint
/// do PWA sabe trocar. Entregar o arquivo cru deixaria o nonce literal no HTML e quebraria a CSP.
/// </summary>
internal sealed class IndexHidingFileProvider(IFileProvider inner) : IFileProvider
{
    public IFileInfo GetFileInfo(string subpath)
    {
        var normalized = (subpath ?? string.Empty).Trim('/');
        return string.Equals(normalized, PwaIndexRenderer.IndexFile, StringComparison.OrdinalIgnoreCase)
            ? new NotFoundFileInfo(PwaIndexRenderer.IndexFile)
            : inner.GetFileInfo(subpath!);
    }

    public IDirectoryContents GetDirectoryContents(string subpath) => inner.GetDirectoryContents(subpath);

    public IChangeToken Watch(string filter) => inner.Watch(filter);
}

/// <summary>Lê o <c>index.html</c> uma vez e troca os marcadores por requisição.</summary>
internal sealed class PwaIndexRenderer(IWebHostEnvironment environment, IOptions<PwaOptions> options)
{
    public const string IndexFile = "index.html";
    private const string NonceMarker = "__CSP_NONCE__";
    private const string ManifestMarker = "<!--uniover:manifest-->";

    private readonly Lazy<string?> _template = new(() => Load(environment));

    public bool IsAvailable => _template.Value is not null;

    public string Render(string nonce, PathString requestPath)
    {
        var html = _template.Value ?? throw new InvalidOperationException("index.html não encontrado em wwwroot.");

        // O slug vem da configuração (nunca do texto da requisição), então o HTML não carrega entrada do cliente.
        var slug = options.Value.Modules.FirstOrDefault(m =>
            requestPath.StartsWithSegments("/" + m, StringComparison.OrdinalIgnoreCase));
        var prefix = slug is null ? string.Empty : "/" + slug;
        var manifest =
            $"""<link rel="manifest" href="{prefix}/manifest.webmanifest"><link rel="apple-touch-icon" href="{prefix}/apple-touch-icon.png">""";

        return html
            .Replace(NonceMarker, nonce, StringComparison.Ordinal)
            .Replace(ManifestMarker, manifest, StringComparison.Ordinal);
    }

    private static string? Load(IWebHostEnvironment environment)
    {
        var file = environment.WebRootFileProvider.GetFileInfo(IndexFile);
        if (!file.Exists)
        {
            return null;
        }

        using var reader = new StreamReader(file.CreateReadStream(), Encoding.UTF8);
        return reader.ReadToEnd();
    }
}

public static class PwaExtensions
{
    public static IServiceCollection AddUniOverPwa(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        services.AddOptions<PwaOptions>().Bind(configuration.GetSection("Pwa"));
        services.AddSingleton<PwaIndexRenderer>();
        return services;
    }

    /// <summary>Arquivos estáticos do PWA, exceto o <c>index.html</c>, que só sai pelo endpoint de fallback.</summary>
    public static IApplicationBuilder UseUniOverStaticFiles(this WebApplication app)
    {
        ArgumentNullException.ThrowIfNull(app);
        return app.UseStaticFiles(new StaticFileOptions
        {
            FileProvider = new IndexHidingFileProvider(app.Environment.WebRootFileProvider),
        });
    }

    /// <summary>
    /// Entrega o <c>index.html</c> com nonce e manifest por módulo em <c>/</c>, <c>/index.html</c> e em
    /// qualquer navegação do PWA. <c>/api</c>, <c>/health</c> e <c>/openapi</c> desconhecidos dão 404.
    /// </summary>
    public static IEndpointRouteBuilder MapUniOverPwa(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        // Rotas desconhecidas dessas áreas devem dar 404 em vez de cair no index.html do PWA.
        // Só GET/HEAD: um fallback para todos os métodos vence o roteador quando o corpo vem sem Content-Type e
        // esconde o 415 (ou a execução, se o corpo é opcional) da rota real atrás de um 404.
        endpoints.MapFallback("/api/{**path}", () => Results.NotFound()).AllowAnonymous().ExcludeFromDescription().WithMetadata(new HttpMethodMetadata(["GET", "HEAD"]));
        endpoints.MapFallback("/health/{**path}", () => Results.NotFound()).AllowAnonymous();
        endpoints.MapFallback("/openapi/{**path}", () => Results.NotFound()).AllowAnonymous();

        endpoints.MapGet("/", ServeIndex).AllowAnonymous();
        endpoints.MapGet("/index.html", ServeIndex).AllowAnonymous();
        // Só GET/HEAD navegam: um POST em rota desconhecida não deve receber HTML com 200.
        endpoints.MapFallback(ServeIndex).AllowAnonymous().WithMetadata(new HttpMethodMetadata(["GET", "HEAD"]));
        return endpoints;
    }

    private static IResult ServeIndex(HttpContext context, PwaIndexRenderer renderer, ICspNonce nonce)
    {
        if (!renderer.IsAvailable)
        {
            return Results.NotFound();
        }

        context.Response.Headers.CacheControl = "no-cache";
        return Results.Content(renderer.Render(nonce.Value, context.Request.Path), "text/html; charset=utf-8");
    }
}
