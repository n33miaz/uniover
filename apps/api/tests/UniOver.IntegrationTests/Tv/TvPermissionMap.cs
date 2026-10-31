using System.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Guards;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// Uma rota da TV, a permissão que a guarda e como chamá-la nos testes. <paramref name="Body"/> é só o corpo mínimo para
/// a chamada chegar ao tratamento da rota (a autorização roda antes de qualquer leitura de corpo).
/// </summary>
internal sealed record TvRoute(string Method, string Pattern, string Permission, object? Body = null)
{
    public HttpMethod HttpMethod => new(Method);

    /// <summary>O fluxo ao vivo só abre com o bilhete em cookie, nunca com o JWT de acesso.</summary>
    public bool IsStream => Pattern.EndsWith("/events", StringComparison.Ordinal);

    /// <summary>O caminho com um id de atalho de exemplo no lugar do parâmetro.</summary>
    public string Url(Guid? id = null) => Pattern.Replace("{id:guid}", (id ?? Guid.NewGuid()).ToString(), StringComparison.Ordinal);

    public override string ToString() => $"{Method} {Pattern}";
}

/// <summary>
/// Uma rota da TV que é só do administrador (configuração): sem permissão da TV, papel exatamente administrador e, quando
/// <paramref name="StepUpAction"/> existe, a confirmação com a passkey dessa ação. Fica fora de <see cref="TvPermissionMap.Routes"/>
/// de propósito: aquela tabela alimenta a matriz de permissões do convidado, e o convidado nunca passa por aqui.
/// </summary>
internal sealed record TvAdminRoute(string Method, string Pattern, string? StepUpAction = null, object? Body = null)
{
    public HttpMethod HttpMethod => new(Method);

    /// <summary>O caminho com uma TV de exemplo no lugar do parâmetro.</summary>
    public string Url(Guid? id = null) => Pattern.Replace("{id:guid}", (id ?? Guid.NewGuid()).ToString(), StringComparison.Ordinal);

    public override string ToString() => $"{Method} {Pattern}";
}

/// <summary>
/// A tabela rota → permissão da TV, escrita por extenso de propósito (não vem das constantes do código): os testes provam
/// o que o produto promete, e quem muda uma permissão de rota precisa mudar esta linha de propósito. A rota pública
/// <c>/tv/info</c> não entra. As varreduras exigem que toda rota da TV esteja aqui (ou em <see cref="AdminRoutes"/>) e que
/// toda linha tenha a sua rota.
/// </summary>
internal static class TvPermissionMap
{
    private const string TvPrefix = "/api/v1/tv/";

    private static readonly object KeyBody = new { key = "HOME" };

    private static readonly object TextBody = new { text = "filme" };

    private static readonly object RenameBody = new { customLabel = "Meu app" };

    private static readonly object OrderBody = new { ids = new[] { Guid.NewGuid() } };

    private static readonly object LayoutBody = new { buttonSize = "large" };

    public static IReadOnlyList<TvRoute> Routes { get; } =
    [
        new("GET", "/api/v1/tv/state", "module:tv"),
        new("GET", "/api/v1/tv/shortcuts", "module:tv"),
        new("GET", "/api/v1/tv/layout", "module:tv"),
        new("GET", "/api/v1/tv/events", "module:tv"),
        new("GET", "/api/v1/tv/tvs", "module:tv"),
        new("POST", "/api/v1/tv/keys", "tv:control", KeyBody),
        new("POST", "/api/v1/tv/text", "tv:control", TextBody),
        new("POST", "/api/v1/tv/wake", "tv:control"),
        new("POST", "/api/v1/tv/cleanup", "tv:control"),
        new("POST", "/api/v1/tv/power/off", "tv:power"),
        new("GET", "/api/v1/tv/power/schedule", "tv:power"),
        new("PUT", "/api/v1/tv/power/schedule", "tv:power", new { dueAtUtc = DateTimeOffset.UtcNow.AddHours(1), timeZone = "America/Sao_Paulo" }),
        new("DELETE", "/api/v1/tv/power/schedule", "tv:power"),
        new("POST", "/api/v1/tv/shortcuts/{id:guid}/launch", "tv:launch"),
        new("POST", "/api/v1/tv/shortcuts/refresh", "tv:launch"),
        new("PATCH", "/api/v1/tv/shortcuts/{id:guid}", "tv:edit-shortcuts", RenameBody),
        new("PUT", "/api/v1/tv/shortcuts/order", "tv:edit-shortcuts", OrderBody),
        new("GET", "/api/v1/tv/commands/recent", "tv:history"),
        new("GET", "/api/v1/tv/cleanup/latest", "tv:control"),
    ];

    /// <summary>
    /// As rotas da TV que só o administrador alcança: ler a configuração (o computador que controla a TV) e trocá-lo, esta
    /// última com a passkey. Nenhuma delas é de convidado, qualquer que seja a permissão que ele tenha.
    /// </summary>
    public static IReadOnlyList<TvAdminRoute> AdminRoutes { get; } =
    [
        new("GET", "/api/v1/tv/config"),
        new("PUT", "/api/v1/tv/config/agent", "tv.bind-agent", new { agentSlug = TvApp.AgentSlug }),
        new("POST", "/api/v1/tv/tvs", "tv.bind-agent", new { agentSlug = TvApp.AgentSlug, name = "TV adicional" }),
        new("PATCH", "/api/v1/tv/tvs/{id:guid}", "tv.bind-agent", new { name = "TV adicional" }),
        new("DELETE", "/api/v1/tv/tvs/{id:guid}", "tv.bind-agent"),
        new("GET", "/api/v1/tv/tvs/{id:guid}/members"),
        new("GET", "/api/v1/tv/tvs/{id:guid}/cleanup-reports"),
        new("GET", "/api/v1/tv/tvs/{id:guid}/apps"),
        new("PUT", "/api/v1/tv/tvs/{id:guid}/members", "tv.bind-agent", new { userIds = new[] { Guid.NewGuid() } }),
        new("POST", "/api/v1/tv/layout", Body: LayoutBody),
        new("PUT", "/api/v1/tv/layout", Body: LayoutBody),
    ];

    /// <summary>A chamada chegou à rota: a autorização deixou passar (o que veio depois é assunto do tratamento dela).</summary>
    public static bool Reached(HttpStatusCode status) => status is not (HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden);

    /// <summary>A rota do módulo de aparelhos em que o convidado aprova o pareamento do PC dele como a própria TV.</summary>
    public const string OwnPairingRoute = "/api/v1/devices/pairing/approve-own";

    /// <summary>
    /// Confere as rotas contra a tabela: cada rota da TV (fora a pública) declara exatamente a permissão da sua linha, com
    /// papel conhecido e conta ativa; o fluxo ao vivo autentica só pelo bilhete; nenhuma rota de outro módulo carrega
    /// permissão da TV; e nenhuma linha fica sem rota.
    /// </summary>
    public static async Task<List<string>> ViolationsAsync(IEnumerable<RouteEndpoint> endpoints, IAuthorizationPolicyProvider policies)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        ArgumentNullException.ThrowIfNull(policies);

        var found = new List<string>();
        var covered = new HashSet<TvRoute>();
        var coveredAdmin = new HashSet<TvAdminRoute>();
        foreach (var endpoint in endpoints)
        {
            var pattern = RouteInspector.Pattern(endpoint);
            var label = RouteInspector.Describe(endpoint);
            var authorize = endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>();
            var policy = authorize.Count == 0 ? null : await AuthorizationPolicy.CombineAsync(policies, authorize);
            var permissions = policy?.Requirements.OfType<PermissionRequirement>().Select(r => r.Permission).ToList() ?? [];

            if (!pattern.StartsWith(TvPrefix, StringComparison.Ordinal))
            {
                // Única exceção, declarada: o convidado que pareia o PC como a própria TV. A rota mora no módulo de aparelhos,
                // exige só 'module:tv' e, junto, a reconfirmação da senha dessa ação; qualquer outra combinação é violação.
                // Em Development com a confirmação desligada (como nos hosts de teste da TV) vale só a permissão; que a senha é
                // exigida no host de produção quem prova é o GuestSelfApprovalTests.
                var stepUps = policy?.Requirements.OfType<StepUpRequirement>().Select(r => r.Action).ToList() ?? [];
                var isOwnPairing = pattern == OwnPairingRoute
                    && permissions.SequenceEqual([AccessPermissions.TvModule])
                    && (stepUps.Count == 0 || stepUps.SequenceEqual([GuestStepUpActions.PairSelf]));
                if (isOwnPairing)
                {
                    continue;
                }

                found.AddRange(permissions
                    .Where(p => p == AccessPermissions.TvModule || p.StartsWith("tv:", StringComparison.Ordinal))
                    .Select(p => $"{label}: rota fora da TV com a permissão da TV '{p}'"));
                continue;
            }

            if (RouteInspector.Classify(endpoint) == RouteKind.Public)
            {
                continue;
            }

            var methods = RouteInspector.Methods(endpoint);
            if (methods.Count == 0)
            {
                found.Add($"{label}: rota da TV sem método explícito");
                continue;
            }

            foreach (var method in methods)
            {
                var admin = AdminRoutes.SingleOrDefault(r =>
                    string.Equals(r.Method, method, StringComparison.OrdinalIgnoreCase) && r.Pattern == pattern);
                if (admin is not null)
                {
                    coveredAdmin.Add(admin);
                    found.AddRange(AdminViolations(admin, policy, permissions));
                    continue;
                }

                var rule = Routes.SingleOrDefault(r =>
                    string.Equals(r.Method, method, StringComparison.OrdinalIgnoreCase) && r.Pattern == pattern);
                if (rule is null)
                {
                    found.Add($"{method} {pattern}: rota da TV fora do mapa de permissões (rota nova precisa de permissão e de uma linha aqui)");
                    continue;
                }

                covered.Add(rule);
                if (policy is null)
                {
                    found.Add($"{rule}: sem política");
                    continue;
                }

                if (permissions.Count != 1 || permissions[0] != rule.Permission)
                {
                    found.Add($"{rule}: declara [{string.Join(", ", permissions)}] e a tabela manda '{rule.Permission}'");
                }

                var roles = policy.Requirements.OfType<AccountRoleRequirement>().SelectMany(r => r.Roles).ToList();
                if (!roles.Contains(AccountRoles.Owner) || !roles.Contains(AccountRoles.Guest) || roles.Count != 2)
                {
                    found.Add($"{rule}: o papel aceito deveria ser exatamente administrador e convidado");
                }

                if (!policy.Requirements.OfType<ActiveAccountRequirement>().Any())
                {
                    found.Add($"{rule}: sem a conferência de conta ativa");
                }

                var stream = policy.AuthenticationSchemes.SequenceEqual([UniOverAuth.StreamScheme]);
                if (rule.IsStream != stream || (!rule.IsStream && policy.AuthenticationSchemes.Count != 0))
                {
                    found.Add($"{rule}: o esquema de autenticação deveria ser {(rule.IsStream ? "só o bilhete de stream" : "o padrão (cabeçalho Authorization)")}");
                }
            }
        }

        found.AddRange(Routes.Where(r => !covered.Contains(r)).Select(r => $"{r}: linha da tabela sem rota correspondente"));
        found.AddRange(AdminRoutes.Where(r => !coveredAdmin.Contains(r)).Select(r => $"{r}: linha de administrador sem rota correspondente"));
        return found;
    }

    /// <summary>
    /// Uma rota de administrador: política presente, nenhuma permissão da TV (não é de quem usa a TV), papel exatamente
    /// administrador, conta ativa não exigida aqui (a política do papel já cobre) e a confirmação da ação quando a linha manda.
    /// </summary>
    private static IEnumerable<string> AdminViolations(TvAdminRoute rule, AuthorizationPolicy? policy, List<string> permissions)
    {
        if (policy is null)
        {
            yield return $"{rule}: sem política";
            yield break;
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

        var actions = policy.Requirements.OfType<StepUpRequirement>().Select(r => r.Action).ToList();
        if (rule.StepUpAction is null ? actions.Count != 0 : !actions.SequenceEqual([rule.StepUpAction]))
        {
            yield return $"{rule}: a confirmação com a passkey deveria ser {(rule.StepUpAction is null ? "nenhuma" : $"'{rule.StepUpAction}'")} (a rota exige [{string.Join(", ", actions)}])";
        }
    }
}
