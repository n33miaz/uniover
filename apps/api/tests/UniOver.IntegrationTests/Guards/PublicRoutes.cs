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
        new("GET", "/health/version", "versão pública conferida pela esteira após o deploy"),

        // Só existe em Development; documenta a API para quem desenvolve.
        new("*", "/openapi/{documentName}.json", "documento OpenAPI, mapeado apenas em Development"),

        // Descrição mínima do módulo (nome e versão), sem dado do usuário.
        new("GET", "/api/v1/identity/info", "informação pública do módulo de conta"),
        new("GET", "/api/v1/tv/info", "informação pública do módulo de TV"),
        new("GET", "/api/v1/devices/info", "informação pública do módulo de aparelhos"),

        // O agente que pede pareamento ainda não tem credencial; o limite por IP e o teto de pareamentos abertos protegem a rota.
        new("POST", "/api/v1/devices/pairing/start", "agente pede um código de pareamento: ainda não existe token"),

        // A credencial desta consulta é o deviceCode (segredo de 32 bytes que só o agente conhece).
        new("POST", "/api/v1/devices/pairing/poll", "agente consulta o pareamento com o deviceCode para recolher o token"),

        // Quem faz login ainda não tem credencial; o limite por IP e o bloqueio por conta protegem a rota.
        new("POST", "/api/v1/identity/auth/login", "entrada por senha: ainda não existe sessão"),

        // O refresh se autentica pelo cookie HttpOnly próprio, não pelo JWT de acesso (que já expirou).
        new("POST", "/api/v1/identity/auth/refresh", "renovação por cookie de refresh rotativo"),

        // Quem recebeu o link do dono ainda não tem conta nem sessão. A credencial é o segredo do convite (32 bytes aleatórios,
        // uso único, validade curta, só o hash no banco), no corpo e nunca na URL; o limite por IP é próprio (balde separado do login).
        new("POST", "/api/v1/identity/guest-invites/accept", "convidado aceita o convite do dono e define a própria senha: ainda não existe sessão"),

        // Entrada pelo QR: o computador que mostra o QR ainda não tem sessão. `start` só cria um pedido (limite por IP baixo, teto de
        // pedidos abertos); `poll` se autentica pelo segredo de consulta (32 bytes aleatórios, só o hash no banco, no corpo), que só
        // o navegador que pediu conhece, e entrega a sessão uma única vez depois que o celular logado confirma.
        new("POST", "/api/v1/identity/auth/qr/start", "computador pede um QR de entrada: ainda não existe sessão"),
        new("POST", "/api/v1/identity/auth/qr/poll", "computador consulta o QR com o segredo de consulta para receber a sessão"),

        // O app Atalhos do iPhone (e a Siri) não tem sessão. A credencial é a chave do atalho, no cabeçalho X-Atalho-Token (32 bytes
        // aleatórios, só o hash no banco), que vale para uma TV e só para as ações escolhidas na criação; o limite por IP é próprio.
        new("POST", "/api/v1/shortcuts/tv", "ordem de um atalho do iPhone à TV, autenticada pela chave do atalho"),

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
