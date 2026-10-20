using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv;

namespace UniOver.IntegrationTests.Guards;

internal enum RouteKind
{
    Public,
    Protected,
    StepUp,
    Stream,
}

/// <summary>Leitura dos metadados de uma rota e a regra de "política explícita" (a varredura de rotas).</summary>
internal static partial class RouteInspector
{
    [GeneratedRegex(@"\{(?<star>\*{0,2})(?<name>[^:}?=]+)(?::(?<constraint>[^}?=]+))?[^}]*\}", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex Placeholder();

    public static string Pattern(RouteEndpoint endpoint) => endpoint.RoutePattern.RawText ?? string.Empty;

    /// <summary>Métodos que a rota atende; vazio quando ela não restringe.</summary>
    public static IReadOnlyList<string> Methods(RouteEndpoint endpoint) =>
        endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods.ToList() ?? [];

    /// <summary>Módulo dono da rota, pelo prefixo <c>/api/v1/&lt;modulo&gt;/</c>; o resto é do Host.</summary>
    public static string Module(string pattern)
    {
        const string prefix = "/api/v1/";
        if (!pattern.StartsWith(prefix, StringComparison.Ordinal))
        {
            return "host";
        }

        var rest = pattern[prefix.Length..];
        var slash = rest.IndexOf('/', StringComparison.Ordinal);
        return slash < 0 ? rest : rest[..slash];
    }

    public static string Describe(RouteEndpoint endpoint)
    {
        var methods = Methods(endpoint);
        return (methods.Count == 0 ? "*" : string.Join(',', methods)) + " " + Pattern(endpoint);
    }

    public static RouteKind Classify(RouteEndpoint endpoint)
    {
        var authorize = endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>();
        if (authorize.Any(a => a.Policy is UniOverAuth.StreamPolicy or TvAuth.StreamPolicy))
        {
            return RouteKind.Stream;
        }

        if (authorize.Any(a => a.Policy is not null && a.Policy.StartsWith(StepUp.PolicyPrefix, StringComparison.Ordinal)))
        {
            return RouteKind.StepUp;
        }

        var isPublic = PublicRoutes.Covers(Pattern(endpoint), Methods(endpoint));
        return isPublic ? RouteKind.Public : RouteKind.Protected;
    }

    public static string? RateLimitPolicy(RouteEndpoint endpoint) =>
        endpoint.Metadata.GetMetadata<DisableRateLimitingAttribute>() is not null
            ? null
            : endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()?.PolicyName;

    /// <summary>
    /// Todas as violações da regra: rota pública precisa estar na lista e declarar <c>AllowAnonymous</c>; rota
    /// fora da lista precisa declarar uma política (<c>IAuthorizeData</c>) e nunca <c>AllowAnonymous</c>.
    /// A política padrão (fallback) não conta: ela é a rede de baixo, não a declaração de quem escreveu a rota.
    /// </summary>
    public static List<string> Violations(IEnumerable<RouteEndpoint> endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var found = new List<string>();
        foreach (var endpoint in endpoints)
        {
            var pattern = Pattern(endpoint);
            var module = Module(pattern);
            var label = Describe(endpoint);
            var listed = PublicRoutes.Covers(pattern, Methods(endpoint));
            var anonymous = endpoint.Metadata.GetMetadata<IAllowAnonymous>() is not null;
            var hasPolicy = endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>().Count > 0;

            if (listed)
            {
                if (!anonymous)
                {
                    found.Add($"rota {label} (módulo {module}) está na lista de públicas mas não declara AllowAnonymous");
                }
            }
            else if (anonymous)
            {
                found.Add($"rota {label} (módulo {module}) é anônima e está fora da lista de públicas");
            }
            else if (!hasPolicy)
            {
                found.Add($"rota {label} (módulo {module}) sem política explícita e fora da lista de públicas");
            }
        }

        return found;
    }

    /// <summary>Troca os parâmetros do padrão por valores de exemplo que satisfazem a restrição declarada.</summary>
    public static string FillSample(string pattern)
    {
        ArgumentNullException.ThrowIfNull(pattern);

        var path = Placeholder().Replace(pattern, match =>
        {
            if (match.Groups["star"].Value.Length > 0)
            {
                return "sample/path";
            }

            return match.Groups["constraint"].Value switch
            {
                "guid" => Guid.NewGuid().ToString(),
                "int" or "long" or "min(1)" => "1",
                "alpha" => "sample",
                var c when c.StartsWith("regex", StringComparison.Ordinal) => "1",
                _ => "sample",
            };
        });
        return path.StartsWith('/') ? path : "/" + path;
    }
}
