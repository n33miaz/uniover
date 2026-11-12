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

    /// <summary>
    /// De quanto em quanto o AGENTE manda o <c>agent.keepalive.v1</c> (25 s hoje, mesmo ocioso; não é o batimento da API,
    /// <see cref="ApplicationKeepAliveSeconds"/>). Os limites da saúde (<see cref="AgentHealth"/>) derivam dele: o silêncio que
    /// marca "sem resposta" (<see cref="HealthSilence"/>, 1,4 intervalo) e o calado que faz um prazo estourado contar como
    /// "mudo" (<see cref="HealthMuteAfter"/>, 1,2 intervalo). Com um batimento mais curto, basta mudar este número.
    /// </summary>
    public int AgentKeepAliveSeconds { get; set; } = 25;

    /// <summary>
    /// Quantos prazos estourados "mudos" (o agente calado há <see cref="HealthMuteAfter"/>, cada um enviado depois do anterior)
    /// marcam "sem resposta" antes do silêncio completo. Dois: um só pode ser um comando legitimamente demorado.
    /// </summary>
    public int HealthStalledMisses { get; set; } = 2;

    /// <summary>
    /// Idade a partir da qual um movimento puro do mouse ainda na fila de saída é descartado em vez de enviado. O movimento é
    /// RELATIVO: descartá-lo muda a posição final do ponteiro (o que já ficou para trás não é refeito), troca aceita para que o
    /// mouse não chegue em rajada atrasada nem derrube a conexão. Por isso só o movimento puro é descartado; o que leva rolagem
    /// sempre sai (a rolagem perdida não volta). Também limita a fila: os movimentos ocupam no máximo três quartos dela, e o que
    /// passar disso é descartado (os cliques, as teclas e a rolagem sempre têm lugar).
    /// </summary>
    public int StaleInputMilliseconds { get; set; } = 1000;

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

    /// <summary>Sem nenhum quadro por isto, o agente está "sem resposta": 1,4 batimento (35 s com o de 25 s).</summary>
    public TimeSpan HealthSilence => TimeSpan.FromSeconds(AgentKeepAliveSeconds * 1.4);

    /// <summary>Um prazo estourado só conta como "mudo" com o agente calado há isto: 1,2 batimento (30 s com o de 25 s).</summary>
    public TimeSpan HealthMuteAfter => TimeSpan.FromSeconds(AgentKeepAliveSeconds * 1.2);

    public TimeSpan StaleInput => TimeSpan.FromMilliseconds(StaleInputMilliseconds);

    /// <summary>Quantos movimentos do mouse cabem na fila de saída (três quartos dela, ao menos um).</summary>
    public int DroppableQueueLimit => Math.Max(1, QueueCapacity * 3 / 4);

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
            && o.AgentKeepAliveSeconds is >= 1 and <= 300
            && o.HealthStalledMisses is >= 1 and <= 10
            && o.StaleInputMilliseconds is >= 100 and <= 60_000
            && o.Sse.IsValid();
    }
}
