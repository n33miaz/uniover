using System.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Guards;

namespace UniOver.IntegrationTests.Training;

/// <summary>
/// Uma rota do Treino que é de quem tem a permissão <c>module:training</c>: os dados da própria conta e a leitura do
/// catálogo. <paramref name="Body"/> é só o corpo mínimo para a chamada chegar ao tratamento da rota (a autorização roda
/// antes de qualquer leitura de corpo).
/// </summary>
internal sealed record TrainingRoute(string Method, string Pattern, string Permission, object? Body = null)
{
    public HttpMethod HttpMethod => new(Method);

    /// <summary>O caminho com ids de exemplo no lugar dos parâmetros.</summary>
    public string Url() => TrainingPermissionMap.Fill(Pattern);

    public override string ToString() => $"{Method} {Pattern}";
}

/// <summary>
/// Uma rota do Treino que escreve dado GLOBAL (o catálogo compartilhado): só o administrador, qualquer que seja a
/// permissão do convidado. Fica fora de <see cref="TrainingPermissionMap.Routes"/> de propósito: aquela tabela alimenta as
/// matrizes do convidado, e o convidado nunca passa por aqui.
/// </summary>
internal sealed record TrainingAdminRoute(string Method, string Pattern, object? Body = null)
{
    public HttpMethod HttpMethod => new(Method);

    public string Url() => TrainingPermissionMap.Fill(Pattern);

    public override string ToString() => $"{Method} {Pattern}";
}

/// <summary>
/// A tabela rota → permissão do Treino, escrita por extenso de propósito (não vem das constantes do código): os testes
/// provam o que o produto promete, e quem muda a permissão de uma rota precisa mudar esta linha de propósito. As
/// varreduras exigem que TODA rota do Treino esteja aqui (ou em <see cref="AdminRoutes"/>), com política NOMEADA, e que toda
/// linha tenha a sua rota: rota nova do Treino sem política ou sem linha faz a CI falhar.
/// </summary>
internal static class TrainingPermissionMap
{
    private const string TrainingPrefix = "/api/v1/training/";

    public const string Module = "module:training";

    private static readonly object StepBody = new { stepKg = 2.5m, clientUpdatedAt = DateTimeOffset.UtcNow };

    private static readonly object GoalBody = new { value = 3m, clientUpdatedAt = DateTimeOffset.UtcNow };

    public static IReadOnlyList<TrainingRoute> Routes { get; } =
    [
        new("GET", "/api/v1/training/exercises", Module),
        new("PUT", "/api/v1/training/exercises/{id:guid}", Module, TrainingApp.CustomBody(DateTimeOffset.UtcNow)),
        new("PUT", "/api/v1/training/exercises/{id:guid}/step", Module, StepBody),
        new("GET", "/api/v1/training/catalog/credits", Module),
        new("GET", "/api/v1/training/goals", Module),
        new("PUT", "/api/v1/training/goals/{kind}", Module, GoalBody),
        new("GET", "/api/v1/training/routine-templates", Module),
        new("GET", "/api/v1/training/routines", Module),
        new("PUT", "/api/v1/training/routines/{id:guid}", Module, new { name = "A", clientUpdatedAt = DateTimeOffset.UtcNow }),
        new("GET", "/api/v1/training/sessions", Module),
        new("GET", "/api/v1/training/sets", Module),
        new("PUT", "/api/v1/training/sessions/{id:guid}", Module, new { deviceId = "a", clientUpdatedAt = DateTimeOffset.UtcNow }),
        new("PUT", "/api/v1/training/sessions/{sessionId:guid}/sets/{id:guid}", Module, new { clientUpdatedAt = DateTimeOffset.UtcNow }),
        new("GET", "/api/v1/training/body/entries", Module),
        new("PUT", "/api/v1/training/body/entries/{id:guid}", Module, new { weightKg = 80m, clientUpdatedAt = DateTimeOffset.UtcNow }),
        new("GET", "/api/v1/training/body/profile", Module),
        new("PUT", "/api/v1/training/body/profile", Module, new { heightCm = 180m, clientUpdatedAt = DateTimeOffset.UtcNow }),
        new("GET", "/api/v1/training/foods", Module),
        new("PUT", "/api/v1/training/foods/{id:guid}", Module, new { name = "Maçã", kcalPer100g = 52m, proteinPer100g = .3m, carbsPer100g = 14m, fatPer100g = .2m, clientUpdatedAt = DateTimeOffset.UtcNow }),
        new("GET", "/api/v1/training/foods/off/search", Module),
        new("GET", "/api/v1/training/foods/off/barcode/{barcode}", Module),
        new("GET", "/api/v1/training/meals", Module),
        new("PUT", "/api/v1/training/meals/{id:guid}", Module, new { eatenOn = DateOnly.FromDateTime(DateTime.UtcNow), mealType = "lunch", name = "Maçã", quantityG = 100m, kcal = 52m, proteinG = .3m, carbG = 14m, fatG = .2m, clientUpdatedAt = DateTimeOffset.UtcNow }),
    ];

    /// <summary>
    /// As rotas do Treino que só o administrador alcança: a importação do catálogo do wger grava o que TODOS os usuários
    /// enxergam e gasta a cota de um serviço externo. Nenhuma delas é de convidado, qualquer que seja a permissão dele.
    /// </summary>
    public static IReadOnlyList<TrainingAdminRoute> AdminRoutes { get; } =
    [
        new("POST", "/api/v1/training/catalog/imports/wger"),
        new("POST", "/api/v1/training/foods/imports/taco"),
    ];

    /// <summary>Todas as chamadas do Treino (as de permissão e as de administrador), para as matrizes de HTTP.</summary>
    public static IEnumerable<(string Method, string Pattern, string Url, object? Body)> AllCalls() =>
        Routes.Select(r => (r.Method, r.Pattern, r.Url(), r.Body))
            .Concat(AdminRoutes.Select(r => (r.Method, r.Pattern, r.Url(), r.Body)));

    /// <summary>O caminho com ids de exemplo (e o tipo de meta, que é texto) no lugar dos parâmetros.</summary>
    public static string Fill(string pattern) => pattern
        .Replace("{sessionId:guid}", Guid.NewGuid().ToString(), StringComparison.Ordinal)
        .Replace("{id:guid}", Guid.NewGuid().ToString(), StringComparison.Ordinal)
        .Replace("{barcode}", "12345678", StringComparison.Ordinal)
        .Replace("{kind}", "weekly_sessions", StringComparison.Ordinal);

    /// <summary>A chamada chegou à rota: a autorização deixou passar (o que veio depois é assunto do tratamento dela).</summary>
    public static bool Reached(HttpStatusCode status) => status is not (HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden);

    /// <summary>
    /// Confere as rotas contra a tabela: cada rota do Treino declara uma política NOMEADA e exatamente a permissão da sua
    /// linha, com papel conhecido e conta ativa; as de administrador usam só a política do dono, sem permissão; nenhuma rota
    /// de outro módulo carrega <c>module:training</c>; e nenhuma linha fica sem rota.
    /// </summary>
    public static async Task<List<string>> ViolationsAsync(IEnumerable<RouteEndpoint> endpoints, IAuthorizationPolicyProvider policies)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        ArgumentNullException.ThrowIfNull(policies);

        var found = new List<string>();
        var covered = new HashSet<TrainingRoute>();
        var coveredAdmin = new HashSet<TrainingAdminRoute>();
        foreach (var endpoint in endpoints)
        {
            var pattern = RouteInspector.Pattern(endpoint);
            var label = RouteInspector.Describe(endpoint);
            var authorize = endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>();
            var policy = authorize.Count == 0 ? null : await AuthorizationPolicy.CombineAsync(policies, authorize);
            var permissions = policy?.Requirements.OfType<PermissionRequirement>().Select(r => r.Permission).ToList() ?? [];

            if (!pattern.StartsWith(TrainingPrefix, StringComparison.Ordinal))
            {
                found.AddRange(permissions
                    .Where(p => p == AccessPermissions.TrainingModule)
                    .Select(p => $"{label}: rota fora do Treino com a permissão do Treino '{p}'"));
                continue;
            }

            if (RouteInspector.Classify(endpoint) == RouteKind.Public)
            {
                found.Add($"{label}: rota do Treino é pública (todo o módulo exige login e permissão)");
                continue;
            }

            // Política NOMEADA em cada rota: `.RequireAuthorization()` sem nome cai na padrão e passaria despercebido.
            if (authorize.Count == 0 || authorize.Any(a => string.IsNullOrWhiteSpace(a.Policy)))
            {
                found.Add($"{label}: rota do Treino sem política nomeada");
                continue;
            }

            var methods = RouteInspector.Methods(endpoint);
            if (methods.Count == 0)
            {
                found.Add($"{label}: rota do Treino sem método explícito");
                continue;
            }

            foreach (var method in methods)
            {
                var admin = AdminRoutes.SingleOrDefault(r =>
                    string.Equals(r.Method, method, StringComparison.OrdinalIgnoreCase) && r.Pattern == pattern);
                if (admin is not null)
                {
                    coveredAdmin.Add(admin);
                    found.AddRange(AdminViolations(admin, authorize, policy!, permissions));
                    continue;
                }

                var rule = Routes.SingleOrDefault(r =>
                    string.Equals(r.Method, method, StringComparison.OrdinalIgnoreCase) && r.Pattern == pattern);
                if (rule is null)
                {
                    found.Add($"{method} {pattern}: rota do Treino fora do mapa de permissões (rota nova precisa de política e de uma linha aqui)");
                    continue;
                }

                covered.Add(rule);
                if (permissions.Count != 1 || permissions[0] != rule.Permission)
                {
                    found.Add($"{rule}: declara [{string.Join(", ", permissions)}] e a tabela manda '{rule.Permission}'");
                }

                var roles = policy!.Requirements.OfType<AccountRoleRequirement>().SelectMany(r => r.Roles).ToList();
                if (!roles.Contains(AccountRoles.Owner) || !roles.Contains(AccountRoles.Guest) || roles.Count != 2)
                {
                    found.Add($"{rule}: o papel aceito deveria ser exatamente administrador e convidado");
                }

                if (!policy.Requirements.OfType<ActiveAccountRequirement>().Any())
                {
                    found.Add($"{rule}: sem a conferência de conta ativa");
                }

                if (policy.AuthenticationSchemes.Count != 0)
                {
                    found.Add($"{rule}: o esquema de autenticação deveria ser o padrão (cabeçalho Authorization)");
                }
            }
        }

        found.AddRange(Routes.Where(r => !covered.Contains(r)).Select(r => $"{r}: linha da tabela sem rota correspondente"));
        found.AddRange(AdminRoutes.Where(r => !coveredAdmin.Contains(r)).Select(r => $"{r}: linha de administrador sem rota correspondente"));
        return found;
    }

    /// <summary>
    /// Uma rota de administrador: a política NOMEADA do dono, nenhuma permissão do catálogo (não é de quem usa o Treino) e o
    /// papel exatamente administrador.
    /// </summary>
    private static IEnumerable<string> AdminViolations(
        TrainingAdminRoute rule, IReadOnlyList<IAuthorizeData> authorize, AuthorizationPolicy policy, List<string> permissions)
    {
        if (!authorize.Select(a => a.Policy).SequenceEqual([UniOverAuth.OwnerPolicy]))
        {
            yield return $"{rule}: rota de administrador deveria declarar a política '{UniOverAuth.OwnerPolicy}' (declara [{string.Join(", ", authorize.Select(a => a.Policy))}])";
        }

        if (permissions.Count != 0)
        {
            yield return $"{rule}: rota de administrador declara a permissão [{string.Join(", ", permissions)}]";
        }

        var roles = policy.Requirements.OfType<AccountRoleRequirement>().SelectMany(r => r.Roles).ToList();
        if (roles.Count != 1 || roles[0] != AccountRoles.Owner)
        {
            yield return $"{rule}: o papel aceito deveria ser exatamente administrador (aceita [{string.Join(", ", roles)}])";
        }
    }
}
