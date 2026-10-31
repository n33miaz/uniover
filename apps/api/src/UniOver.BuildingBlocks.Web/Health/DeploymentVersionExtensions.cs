using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;

namespace UniOver.BuildingBlocks.Web;

/// <summary>Identificador público do código em execução; a esteira de publicação o consulta para confirmar o deploy.</summary>
/// <param name="Commit">Commit publicado (minúsculo), ou <c>null</c> fora do Render.</param>
/// <param name="Version">Versão SemVer do produto compilada no Host.</param>
public sealed record DeploymentVersion(string? Commit, string Version);

public static class DeploymentVersionExtensions
{
    /// <summary>
    /// <c>GET /health/version</c>: devolve o commit que o Render injeta em <c>RENDER_GIT_COMMIT</c> e a versão do produto.
    /// Público e sem banco (como <c>/health/live</c>); o commit de um repositório público não é segredo. Nunca em cache: um
    /// cache entre o deploy e a consulta poderia confirmar por engano o commit anterior.
    /// </summary>
    public static IEndpointConventionBuilder MapDeploymentVersion(
        this IEndpointRouteBuilder endpoints,
        IConfiguration configuration,
        string version)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentException.ThrowIfNullOrWhiteSpace(version);

        return endpoints.MapGet("/health/version", (HttpResponse response) =>
        {
            response.Headers.CacheControl = "no-store";
            return TypedResults.Ok(new DeploymentVersion(
                configuration["RENDER_GIT_COMMIT"]?.Trim().ToLowerInvariant(),
                version));
        }).AllowAnonymous();
    }
}
