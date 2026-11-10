namespace UniOver.Modules.Devices.Domain;

/// <summary>
/// Uma ocorrência que o próprio app no celular (o PWA) contou sobre si: erro do app, requisição que falhou, comando que falhou ou
/// ficou sem resposta. Existe para o administrador entender depois "parecia funcionar, mas não foi" sem reproduzir no aparelho.
/// Só formas fixas: código curto, modelo de rota da lista permitida (nunca o caminho cru), <c>X-Trace-Id</c> da resposta. Nunca
/// guarda mensagem de erro, pilha, texto digitado, endereço de rede nem agente de navegador. Guarda <see cref="UserId"/>, a conta
/// que enviou, lida da sessão autenticada (o aparelho não diz quem é). Não é trilha de auditoria: some em poucos dias e em
/// quantidade limitada.
/// </summary>
public sealed class ClientEvent
{
    public const int KindMax = 16;
    public const int ModuleMax = 12;
    public const int CodeMax = 48;
    public const int TraceIdMax = 64;
    public const int TransportMax = 8;
    public const int VisibilityMax = 8;
    public const int RouteMax = 120;
    public const int VersionMax = 40;

    // Para o EF Core materializar a linha.
    private ClientEvent()
    {
    }

    public Guid Id { get; private set; }

    /// <summary>
    /// A conta que enviou, lida da sessão autenticada. Só um valor (sem chave estrangeira: o módulo Identity é de outro schema,
    /// e a conta pode sair sem apagar o rastro, que some pela retenção).
    /// </summary>
    public Guid UserId { get; private set; }

    /// <summary>O <c>id</c> escolhido pelo app: reenviar o mesmo lote depois de uma queda não duplica nada.</summary>
    public Guid EventId { get; private set; }

    /// <summary>Quando aconteceu, pelo relógio do aparelho (ou a hora do recebimento, se ele estava fora do razoável).</summary>
    public DateTimeOffset At { get; private set; }

    public DateTimeOffset ReceivedAt { get; private set; }

    /// <summary><c>client-error</c>, <c>http-failure</c>, <c>command-failure</c> ou <c>command-slow</c>.</summary>
    public string Kind { get; private set; } = string.Empty;

    /// <summary><c>tv</c>, <c>pc</c>, <c>training</c> ou <c>app</c>.</summary>
    public string Module { get; private set; } = string.Empty;

    /// <summary>Código curto: nome do erro (<c>TypeError</c>), tipo da falha (<c>network</c>) ou código HTTP (<c>http_503</c>).</summary>
    public string? Code { get; private set; }

    /// <summary>Código HTTP, quando a ocorrência veio de uma requisição (0 = sem resposta).</summary>
    public int? Status { get; private set; }

    /// <summary>O <c>X-Trace-Id</c> da resposta, para achar a linha do log da API.</summary>
    public string? TraceId { get; private set; }

    /// <summary><c>cloud</c> (a API) ou <c>direct</c> (o canal direto do PC).</summary>
    public string? Transport { get; private set; }

    /// <summary><c>visible</c> ou <c>hidden</c>: o estado da página quando aconteceu.</summary>
    public string Visibility { get; private set; } = string.Empty;

    /// <summary>A tela em que o app estava, sem query nem identificador (<c>/treino/:id</c>).</summary>
    public string Route { get; private set; } = string.Empty;

    /// <summary>O caminho da API chamada, no mesmo formato da rota.</summary>
    public string? Api { get; private set; }

    /// <summary>A versão do app (PWA).</summary>
    public string? Version { get; private set; }

    /// <summary>Aconteceu na carência da volta ao app (as falhas dessa janela costumam ser da conexão derrubada pelo sistema).</summary>
    public bool Grace { get; private set; }

    public static ClientEvent Create(
        Guid id,
        Guid userId,
        Guid eventId,
        DateTimeOffset at,
        DateTimeOffset receivedAt,
        string kind,
        string module,
        string? code,
        int? status,
        string? traceId,
        string? transport,
        string visibility,
        string route,
        string? api,
        string? version,
        bool grace) =>
        new()
        {
            Id = id,
            UserId = userId,
            EventId = eventId,
            At = at,
            ReceivedAt = receivedAt,
            Kind = kind,
            Module = module,
            Code = code,
            Status = status,
            TraceId = traceId,
            Transport = transport,
            Visibility = visibility,
            Route = route,
            Api = api,
            Version = version,
            Grace = grace,
        };
}
