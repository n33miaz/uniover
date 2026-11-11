using System.Text.Json;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Contracts.Agents;

/// <summary>
/// Mensagem que um módulo quer mandar a um agente. Só o <c>type</c> (ex.: <c>tv.key.v1</c>) e o corpo: o envelope
/// (id, origem, destino, instante) é montado e validado pelo Devices, para que nenhum módulo conheça o transporte.
/// </summary>
/// <param name="Delivery">O que fazer quando o agente está sem sessão no momento do envio (ver <see cref="AgentDelivery"/>).</param>
/// <param name="OperationId">
/// O <c>operationId</c> do envelope (opcional): o código do pedido HTTP que originou o comando, para ligar o registro da API ao do agente.
/// Só vai a um agente que declarou <c>pc.op.v1</c>: o esquema de um agente anterior é fechado.
/// </param>
/// <param name="DeviceId">O <c>deviceId</c> do envelope (opcional): o aparelho do app, para o dono aprová-lo no PC (<c>pc.device.v1</c>).</param>
/// <param name="DeviceName">O <c>deviceName</c> do envelope: o nome para mostrar ao dono. Vem junto com <paramref name="DeviceId"/>.</param>
public sealed record OutboundMessage(
    string Type,
    JsonElement Body,
    AgentDelivery Delivery = AgentDelivery.WaitForReconnect,
    string? OperationId = null,
    string? DeviceId = null,
    string? DeviceName = null);

/// <summary>Como o gateway trata a mensagem quando não há sessão viva com o agente.</summary>
public enum AgentDelivery
{
    /// <summary>
    /// Espera a janela de reconexão (<c>ReconnectGraceSeconds</c>) antes de desistir: serve a comandos que podem chegar
    /// atrasados sem dano, como os da TV, para que a troca de instância do Render não vire erro.
    /// </summary>
    WaitForReconnect = 0,

    /// <summary>
    /// Só entrega se há sessão agora ou se ela volta em poucos segundos (<c>ImmediateReconnectWaitSeconds</c>, e só para o agente
    /// que acabou de cair); senão falha com <c>agent_offline</c>, na hora quando o agente já estava fora do ar. É o de quem age no
    /// PC ao vivo (mouse, teclado, energia): um comando que espera muito e chega depois, junto com os outros, cai em outra janela.
    /// </summary>
    Immediate = 1,
}

/// <summary>Mensagem do agente que já passou pela validação do contrato e pelas checagens de origem e destino.</summary>
/// <param name="AgentId">Slug do agente que mandou (o mesmo do <c>source</c> do envelope).</param>
public sealed record InboundMessage(
    string AgentId,
    Guid Id,
    string Type,
    Guid? CorrelationId,
    DateTimeOffset Timestamp,
    JsonElement Body);

/// <summary>
/// Resposta do agente a um comando (<c>command.result.v1</c>). <c>Ok = false</c> é uma resposta válida: o agente
/// respondeu, só não conseguiu executar; quem pergunta olha <see cref="Error"/>.
/// </summary>
public sealed record AgentReply(Guid CorrelationId, bool Ok, Error? Error);
