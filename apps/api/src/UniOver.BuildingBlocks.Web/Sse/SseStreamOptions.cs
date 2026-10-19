namespace UniOver.BuildingBlocks.Web;

/// <summary>
/// Limites de um fluxo SSE. Os padrões são os aprovados: o servidor encerra sozinho o fluxo a cada 10 minutos
/// (o limite de duração de requisição no Render é incerto e o bilhete de stream é curto) e o PWA reabre.
/// </summary>
public sealed class SseStreamOptions
{
    /// <summary>Fluxos simultâneos por usuário; ao abrir mais um, o mais antigo é fechado.</summary>
    public int MaxStreamsPerUser { get; set; } = 3;

    /// <summary>Intervalo do comentário de keep-alive, que impede proxies de derrubar um fluxo parado.</summary>
    public int KeepAliveSeconds { get; set; } = 15;

    /// <summary>Duração máxima de um fluxo, depois da qual o servidor o encerra para forçar um bilhete novo.</summary>
    public int MaxLifetimeMinutes { get; set; } = 10;

    /// <summary>Mensagens pendentes por assinante; um assinante que não acompanha é fechado e reabre pelo instantâneo.</summary>
    public int SubscriberQueue { get; set; } = 64;

    public TimeSpan KeepAlive => TimeSpan.FromSeconds(KeepAliveSeconds);

    public TimeSpan MaxLifetime => TimeSpan.FromMinutes(MaxLifetimeMinutes);

    /// <summary>Valores que quebrariam o fluxo (zero ou negativo); o módulo prefere cair na partida.</summary>
    public bool IsValid() =>
        MaxStreamsPerUser >= 1 && KeepAliveSeconds >= 1 && MaxLifetimeMinutes >= 1 && SubscriberQueue >= 1;
}
