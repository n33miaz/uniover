using System.Text.Json;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Contracts.Agents;

/// <summary>
/// Mensagem que um módulo quer mandar a um agente. Só o <c>type</c> (ex.: <c>tv.key.v1</c>) e o corpo: o envelope
/// (id, origem, destino, instante) é montado e validado pelo Devices, para que nenhum módulo conheça o transporte.
/// </summary>
public sealed record OutboundMessage(string Type, JsonElement Body);

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
