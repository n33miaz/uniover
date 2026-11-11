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
    /// Passado o prazo o comando falha com "reconectando", e não com "desligado", enquanto a presença segue na graça. Os comandos
    /// do PC (<c>pc.*</c>, <see cref="Contracts.Agents.AgentDelivery.Immediate"/>) agem ao vivo e só esperam o prazo curto de
    /// <see cref="ImmediateReconnectWaitSeconds"/>.
    /// </summary>
    public int ReconnectGraceSeconds { get; set; } = 25;

    /// <summary>
    /// Quanto um comando do PC (<c>pc.*</c>, entrega imediata) espera a volta do agente quando ele acabou de cair (presença ainda
    /// na graça): a troca de instância na publicação leva o agente a reconectar em menos que isto, e "reconectando" só aparece
    /// depois. Agente que já estava fora do ar falha na hora. Zero desliga a espera.
    /// </summary>
    public int ImmediateReconnectWaitSeconds { get; set; } = 5;

    /// <summary>
    /// Quanto um comando já enviado espera o agente voltar depois de a conexão cair: se ele reconecta nesse prazo o resultado
    /// ainda chega (o resultado é ligado ao comando por <c>commandId</c> e agente, não à conexão); se não, o comando falha como
    /// "sem agente". Zero falha na hora.
    /// </summary>
    public int ReplyHoldSeconds { get; set; } = 5;

    /// <summary>
    /// No desligamento da API, quanto esperar os comandos em curso terminarem antes de mandar os agentes reconectarem em outra
    /// instância (o resultado de um comando pendente só chega pela conexão que o enviou). Zero não espera.
    /// </summary>
    public int DrainWaitSeconds { get; set; } = 5;

    /// <summary>
    /// Quanto o agente sem socket ainda aparece conectado (verde): a queda só é mostrada quando se confirma. Cobre os 118 s
    /// medidos; um comando da TV enviado nesse intervalo espera a reconexão (<see cref="ReconnectGraceSeconds"/>) e, se ela não
    /// vem, falha dizendo que o PC está reconectando. Um comando do PC falha na hora, mesmo com a presença ainda verde.
    /// Zero mostra a queda na hora.
    /// </summary>
    public int PresenceGraceSeconds { get; set; } = 150;

    /// <summary>Recusas toleradas na janela; passou disso (a sexta, no padrão), a conexão é fechada.</summary>
    public int RefusalLimit { get; set; } = 5;

    public int RefusalWindowSeconds { get; set; } = 60;

    /// <summary>Quanto esperar o agente responder ao fechamento antes de derrubar a conexão.</summary>
    public int CloseGraceSeconds { get; set; } = 2;

    /// <summary>
    /// Quanto a conexão CANDIDATA da passagem de versão espera para mandar o primeiro quadro (o <c>hello</c> de passagem). Sem ele
    /// neste prazo ela é descartada, e a conexão antiga, que nunca sai por causa deste prazo, segue como a atual.
    /// </summary>
    public int HandoverHelloWaitSeconds { get; set; } = 5;

    /// <summary>Fluxo SSE de presença (limite por usuário, keep-alive e duração máxima).</summary>
    public SseStreamOptions Sse { get; set; } = new();

    public TimeSpan RequestTimeout => TimeSpan.FromSeconds(RequestTimeoutSeconds);

    public TimeSpan KeepAlive => TimeSpan.FromSeconds(KeepAliveSeconds);

    public TimeSpan ApplicationKeepAlive => TimeSpan.FromSeconds(ApplicationKeepAliveSeconds);

    public TimeSpan ReconnectGrace => TimeSpan.FromSeconds(ReconnectGraceSeconds);

    public TimeSpan ImmediateReconnectWait => TimeSpan.FromSeconds(ImmediateReconnectWaitSeconds);

    public TimeSpan ReplyHold => TimeSpan.FromSeconds(ReplyHoldSeconds);

    public TimeSpan DrainWait => TimeSpan.FromSeconds(DrainWaitSeconds);

    public TimeSpan PresenceGrace => TimeSpan.FromSeconds(PresenceGraceSeconds);

    public TimeSpan RefusalWindow => TimeSpan.FromSeconds(RefusalWindowSeconds);

    public TimeSpan CloseGrace => TimeSpan.FromSeconds(CloseGraceSeconds);

    public TimeSpan HandoverHelloWait => TimeSpan.FromSeconds(HandoverHelloWaitSeconds);

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
            && o.ImmediateReconnectWaitSeconds is >= 0 and <= 60
            && o.ReplyHoldSeconds is >= 0 and <= 60
            && o.DrainWaitSeconds is >= 0 and <= 60
            && o.PresenceGraceSeconds is >= 0 and <= 3600
            && o.RefusalLimit >= 1
            && o.RefusalWindowSeconds >= 1
            && o.CloseGraceSeconds >= 0
            && o.HandoverHelloWaitSeconds >= 1
            && o.Sse.IsValid();
    }
}
