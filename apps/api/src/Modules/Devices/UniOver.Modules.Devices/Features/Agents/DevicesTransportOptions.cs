using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Devices.Features.Agents;

/// <summary>Transporte do agente e SSE de estado (<c>Modules:Devices:Transport</c>): padrões aprovados, todos ajustáveis.</summary>
public sealed class DevicesTransportOptions
{
    public const string SectionName = "Modules:Devices:Transport";

    /// <summary>Quanto o <c>RequestAsync</c> espera a resposta quando quem chama não diz.</summary>
    public int RequestTimeoutSeconds { get; set; } = 5;

    /// <summary>Mensagens de saída pendentes por conexão; cheia, a conexão é fechada (agente que não acompanha).</summary>
    public int QueueCapacity { get; set; } = 64;

    /// <summary>Tamanho máximo de uma mensagem recebida (64 KB); mais que isso fecha a conexão.</summary>
    public int MaxMessageBytes { get; set; } = 64 * 1024;

    /// <summary>Intervalo do ping/pong do próprio protocolo WebSocket.</summary>
    public int KeepAliveSeconds { get; set; } = 20;

    /// <summary>Intervalo do batimento JSON que atravessa proxies que ignoram ping/pong WebSocket.</summary>
    public int ApplicationKeepAliveSeconds { get; set; } = 25;

    /// <summary>
    /// Quanto um comando espera a sessão reaparecer depois de uma queda do agente. As quedas medidas em 28/10 (deploy e
    /// manutenção do Render) voltam em 2 a 118 s; 25 s cobre a troca normal sem deixar quem toca o botão esperando demais.
    /// Passado o prazo o comando falha com "reconectando", e não com "desligado", enquanto a presença segue na graça.
    /// </summary>
    public int ReconnectGraceSeconds { get; set; } = 25;

    /// <summary>
    /// Quanto o agente sem socket ainda aparece conectado (verde): a queda só é mostrada quando se confirma. Cobre os 118 s
    /// medidos; um comando enviado nesse intervalo espera a reconexão (<see cref="ReconnectGraceSeconds"/>) e, se ela não
    /// vem, falha dizendo que o PC está reconectando. Zero mostra a queda na hora.
    /// </summary>
    public int PresenceGraceSeconds { get; set; } = 150;

    /// <summary>Recusas toleradas na janela; passou disso (a sexta, no padrão), a conexão é fechada.</summary>
    public int RefusalLimit { get; set; } = 5;

    public int RefusalWindowSeconds { get; set; } = 60;

    /// <summary>Quanto esperar o agente responder ao fechamento antes de derrubar a conexão.</summary>
    public int CloseGraceSeconds { get; set; } = 2;

    /// <summary>Fluxo SSE de presença (limite por usuário, keep-alive e duração máxima).</summary>
    public SseStreamOptions Sse { get; set; } = new();

    public TimeSpan RequestTimeout => TimeSpan.FromSeconds(RequestTimeoutSeconds);

    public TimeSpan KeepAlive => TimeSpan.FromSeconds(KeepAliveSeconds);

    public TimeSpan ApplicationKeepAlive => TimeSpan.FromSeconds(ApplicationKeepAliveSeconds);

    public TimeSpan ReconnectGrace => TimeSpan.FromSeconds(ReconnectGraceSeconds);

    public TimeSpan PresenceGrace => TimeSpan.FromSeconds(PresenceGraceSeconds);

    public TimeSpan RefusalWindow => TimeSpan.FromSeconds(RefusalWindowSeconds);

    public TimeSpan CloseGrace => TimeSpan.FromSeconds(CloseGraceSeconds);

    /// <summary>Valores que quebrariam o transporte (zero ou negativo); o módulo prefere cair na partida a se comportar mal.</summary>
    public static bool IsValid(DevicesTransportOptions o)
    {
        ArgumentNullException.ThrowIfNull(o);
        return o.RequestTimeoutSeconds >= 1
            && o.QueueCapacity >= 1
            && o.MaxMessageBytes >= 1024
            && o.KeepAliveSeconds >= 1
            && o.ApplicationKeepAliveSeconds is >= 1 and < 60
            && o.ReconnectGraceSeconds >= 0
            && o.PresenceGraceSeconds is >= 0 and <= 3600
            && o.RefusalLimit >= 1
            && o.RefusalWindowSeconds >= 1
            && o.CloseGraceSeconds >= 0
            && o.Sse.IsValid();
    }
}
