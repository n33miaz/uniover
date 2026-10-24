using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.AgentProtocol;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Features.Agents;

/// <summary>
/// Entrega comandos de outros módulos aos agentes. Monta o envelope pela fábrica do protocolo (que só o devolve
/// se o próprio validador o aceita: erro de quem chama vira <c>invalid_message</c>, nunca uma mensagem inválida
/// no fio) e, no pedido/resposta, espera o <c>command.result.v1</c> que aponta para o <c>id</c> do comando.
/// </summary>
internal sealed partial class AgentGateway(
    AgentConnections connections,
    OutboundEnvelopeFactory factory,
    IReplyCorrelator correlator,
    IOptions<DevicesTransportOptions> options,
    TimeProvider time,
    ILogger<AgentGateway> logger) : IAgentGateway
{
    public async Task<Result> SendAsync(string agentId, OutboundMessage message, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(message);

        var envelope = Build(agentId, message);
        if (envelope.IsFailure)
        {
            return Result.Failure(envelope.Error);
        }

        return await DeliverAsync(agentId, envelope.Value.Json, cancellationToken)
            ? Result.Success()
            : Result.Failure(AgentErrors.Offline);
    }

    public async Task<Result<AgentReply>> RequestAsync(
        string agentId, OutboundMessage message, TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(message);

        var envelope = Build(agentId, message);
        if (envelope.IsFailure)
        {
            return Result.Failure<AgentReply>(envelope.Error);
        }

        var wait = timeout > TimeSpan.Zero ? timeout : options.Value.RequestTimeout;
        var commandId = envelope.Value.Id;

        // A espera entra no dicionário antes do envio: o agente pode responder antes do SendAsync voltar.
        using var pending = correlator.Expect(agentId, commandId);
        if (!await DeliverAsync(agentId, envelope.Value.Json, cancellationToken))
        {
            return Result.Failure<AgentReply>(AgentErrors.Offline);
        }

        try
        {
            return Result.Success(await pending.Reply.WaitAsync(wait, time, cancellationToken));
        }
        catch (TimeoutException)
        {
            LogRequestTimedOut(agentId, message.Type, commandId);
            return Result.Failure<AgentReply>(AgentErrors.Timeout);
        }
        catch (AgentDisconnectedException)
        {
            return Result.Failure<AgentReply>(AgentErrors.Offline);
        }
    }

    private Result<OutboundEnvelope> Build(string agentId, OutboundMessage message)
    {
        if (string.IsNullOrWhiteSpace(agentId) || string.IsNullOrWhiteSpace(message.Type))
        {
            return Result.Failure<OutboundEnvelope>(AgentErrors.InvalidMessage("Agente e tipo da mensagem são obrigatórios."));
        }

        var created = factory.Create(message.Type, agentId, correlationId: null, message.Body);
        if (created.IsFailure)
        {
            // Erro de programação de quem chama: registra o tipo e o código, nunca o corpo.
            LogOutboundRejected(agentId, message.Type, created.Error.Code);
            return Result.Failure<OutboundEnvelope>(AgentErrors.InvalidMessage("A mensagem não cumpre o contrato do agente."));
        }

        return created;
    }

    private async Task<bool> DeliverAsync(string agentId, byte[] json, CancellationToken cancellationToken)
    {
        if (connections.TryGet(agentId, out var connected) && await connected.SendAsync(json, cancellationToken))
        {
            return true;
        }

        // Deploys e quedas breves do socket levam o agente a reconectar em cerca de dois segundos. Esperar esta
        // janela evita responder `agent_offline` para o comando que coincidiu com a troca, sem reter filas longas.
        var session = await connections.WaitForSessionAsync(
            agentId, options.Value.ReconnectGrace, time, cancellationToken);
        return session is not null && await session.SendAsync(json, cancellationToken);
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Comando {Type} ao agente {AgentId} ({CommandId}) sem resposta no prazo; resposta tardia será descartada.")]
    private partial void LogRequestTimedOut(string agentId, string type, Guid commandId);

    [LoggerMessage(Level = LogLevel.Error, Message = "Mensagem de saída {Type} para o agente {AgentId} recusada pelo contrato ({Reason}).")]
    private partial void LogOutboundRejected(string agentId, string type, string reason);
}
