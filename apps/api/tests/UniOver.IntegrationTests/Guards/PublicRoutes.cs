namespace UniOver.IntegrationTests.Guards;

/// <summary>Uma rota anônima de propósito: método, padrão exato (como o roteador o escreve) e o porquê.</summary>
/// <param name="Method"><c>GET</c>, <c>POST</c>... ou <c>*</c> quando a rota não restringe método.</param>
/// <param name="Pattern">Texto do padrão da rota, igual ao <c>RoutePattern.RawText</c>.</param>
/// <param name="Reason">Por que esta rota precisa ser pública.</param>
internal sealed record PublicRoute(string Method, string Pattern, string Reason);

/// <summary>
/// A lista das únicas rotas que podem responder sem autenticação. Rota pública é exceção explícita: quem cria uma
/// precisa acrescentar a linha aqui (e o teste de varredura falha até alguém decidir, de propósito).
/// Este arquivo é somente de acréscimo: nunca se remove uma linha para fazer um teste passar.
/// </summary>
internal static class PublicRoutes
{
    public static IReadOnlyList<PublicRoute> All { get; } =
    [
        // Monitor externo chama a cada poucos minutos, sem credencial; não toca no banco.
        new("*", "/health/live", "sonda de vida usada pelo monitor externo"),

        // Só existe em Development; documenta a API para quem desenvolve.
        new("*", "/openapi/{documentName}.json", "documento OpenAPI, mapeado apenas em Development"),

        // Descrição mínima do módulo (nome e versão), sem dado do usuário.
        new("GET", "/api/v1/identity/info", "informação pública do módulo de conta"),
        new("GET", "/api/v1/tv/info", "informação pública do módulo de TV"),

        // Quem faz login ainda não tem credencial; o limite por IP e o bloqueio por conta protegem a rota.
        new("POST", "/api/v1/identity/auth/login", "entrada por senha: ainda não existe sessão"),

        // O refresh se autentica pelo cookie HttpOnly próprio, não pelo JWT de acesso (que já expirou).
        new("POST", "/api/v1/identity/auth/refresh", "renovação por cookie de refresh rotativo"),

        // O PWA é público: o navegador precisa do HTML antes de qualquer login.
        new("GET", "/", "página inicial do PWA"),
        new("GET", "/index.html", "página inicial do PWA pelo nome do arquivo"),
        new("GET", "{*path:nonfile}", "navegação do PWA (rotas do Angular caem no index.html)"),
        new("HEAD", "{*path:nonfile}", "navegação do PWA (rotas do Angular caem no index.html)"),

        // Rotas desconhecidas dessas áreas respondem 404 (e não o HTML do PWA); o 404 não revela nada.
        new("*", "/api/{**path}", "404 limpo para rota de API inexistente"),
        new("*", "/health/{**path}", "404 limpo para rota de saúde inexistente"),
        new("*", "/openapi/{**path}", "404 limpo para rota de OpenAPI inexistente"),
    ];

    /// <summary>
    /// Verdadeiro se o padrão está na lista para todos os métodos que a rota atende. Uma rota sem restrição de
    /// método só é coberta por uma linha <c>*</c>: assim um POST anônimo escondido atrás de um GET listado falha.
    /// </summary>
    public static bool Covers(string pattern, IReadOnlyList<string> methods)
    {
        ArgumentNullException.ThrowIfNull(pattern);
        ArgumentNullException.ThrowIfNull(methods);

        var lines = All.Where(r => string.Equals(r.Pattern, pattern, StringComparison.Ordinal)).ToList();
        if (lines.Count == 0)
        {
            return false;
        }

        if (lines.Any(r => r.Method == "*"))
        {
            return true;
        }

        return methods.Count > 0
            && methods.All(m => lines.Any(r => string.Equals(r.Method, m, StringComparison.OrdinalIgnoreCase)));
    }
}
