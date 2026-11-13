using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.AgentProtocol;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Ports;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Features.Agents;

/// <summary>
/// Entrega comandos de outros módulos aos agentes. Monta o envelope pela fábrica do protocolo (que só o devolve
/// se o próprio validador o aceita: erro de quem chama vira <c>invalid_message</c>, nunca uma mensagem inválida
/// no fio) e, no pedido/resposta, espera o <c>command.result.v1</c> que aponta para o <c>id</c> do comando. Cada resposta e
/// cada prazo estourado alimentam a saúde do agente (<see cref="AgentHealth"/>); com o agente conectado mas mudo, o pedido
/// falha na hora (<c>agent_stalled</c>) em vez de esperar o prazo inteiro.
/// </summary>
internal sealed partial class AgentGateway(
    AgentConnections connections,
    OutboundEnvelopeFactory factory,
    IReplyCorrelator correlator,
    IOptions<DevicesTransportOptions> options,
    TimeProvider time,
    ILogger<AgentGateway> logger,
    AgentHealth? agentHealth = null,
    AgentParity? agentParity = null) : IAgentGateway
{
    // Sem a saúde registrada (montagens de teste do gateway sozinho) nada é medido, e o gateway segue como antes.
    private readonly AgentHealth? health = agentHealth;

    // Os números da paridade (Ajustes > Sistema): segundos de uso pela nuvem, resposta dos comandos de entrada, sem resposta.
    private readonly AgentParity? parity = agentParity;

    public async Task<Result> SendAsync(string agentId, OutboundMessage message, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(message);

        var envelope = Build(agentId, message);
        if (envelope.IsFailure)
        {
            return Result.Failure(envelope.Error);
        }

        var droppable = IsPureMove(message);
        if (!await DeliverAsync(agentId, message, envelope.Value, droppable, pending: null, cancellationToken, cancellationToken))
        {
            return Result.Failure(AgentErrors.Offline);
        }

        NoteCloudInput(agentId, message.Type);
        return Result.Success();
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

        // Conectado, mas mudo: o comando não sai (nada fica pendurado no agente para executar ao acordar) e a resposta volta
        // já. Só com sessão viva: sem ela vale a espera da reconexão de sempre, e a saúde já foi esquecida na queda.
        // A soltura de um botão ou de uma tecla nunca é recusada: sem ela o botão ficaria preso no PC quando ele voltar.
        if (connections.TryGet(agentId, out _) && health?.IsUnresponsive(agentId) == true && !IsRelease(message))
        {
            LogStalledFastFail(agentId, message.Type);
            return Result.Failure<AgentReply>(AgentErrors.Stalled);
        }

        // A espera entra no dicionário antes do envio: o agente pode responder antes do SendAsync voltar.
        using var pending = correlator.Expect(agentId, commandId);

        // Se a espera falhar antes de o comando sair (o agente caiu de vez), a entrega para: o comando nunca sai depois de a API
        // já ter respondido falha, senão a pessoa repetiria uma ação que acabaria sendo executada duas vezes.
        using var delivery = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _ = pending.Reply.ContinueWith(
            static (reply, state) =>
            {
                _ = reply.Exception;
                if (reply.IsFaulted)
                {
                    try
                    {
                        ((CancellationTokenSource)state!).Cancel();
                    }
                    catch (ObjectDisposedException)
                    {
                        // A requisição já terminou: nada a cancelar.
                    }
                }
            },
            delivery,
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

        var sentAt = time.GetUtcNow();
        var started = time.GetTimestamp();
        if (!await DeliverAsync(agentId, message, envelope.Value, droppable: false, pending, delivery.Token, cancellationToken))
        {
            return Result.Failure<AgentReply>(AgentErrors.Offline);
        }

        NoteCloudInput(agentId, message.Type);
        try
        {
            var reply = await pending.Reply.WaitAsync(wait, time, cancellationToken);
            var latency = time.GetElapsedTime(started);
            health?.OnReply(agentId, latency, wait);
            if (AgentParity.IsInput(message.Type))
            {
                parity?.OnReply(agentId, latency);
            }

            return Result.Success(reply);
        }
        catch (TimeoutException)
        {
            LogRequestTimedOut(agentId, message.Type, commandId);
            health?.OnTimeout(agentId, sentAt);
            parity?.OnUnanswered(agentId);
            return Result.Failure<AgentReply>(AgentErrors.Timeout);
        }
        catch (AgentDisconnectedException)
        {
            return Result.Failure<AgentReply>(AgentErrors.Offline);
        }
    }

    /// <summary>Um comando de entrada saiu pela nuvem: conta o segundo de uso (a parte "nuvem" da paridade).</summary>
    private void NoteCloudInput(string agentId, string type)
    {
        if (AgentParity.IsInput(type))
        {
            parity?.OnCloudInput(agentId);
        }
    }

    /// <summary>Movimento do mouse sem rolagem: o único envelope que a fila pode descartar (a rolagem perdida não volta).</summary>
    internal static bool IsPureMove(OutboundMessage message) =>
        string.Equals(message.Type, AgentMessageTypes.PcPointerV1, StringComparison.Ordinal)
        && message.Body.ValueKind == JsonValueKind.Object
        && IsZeroOrAbsent(message.Body, "scrollX")
        && IsZeroOrAbsent(message.Body, "scrollY");

    /// <summary>Soltura de botão ou tecla do PC (<c>action: UP</c>, como no <c>pc.click.v1</c> e no <c>pc.key.v2</c>).</summary>
    internal static bool IsRelease(OutboundMessage message) =>
        message.Type.StartsWith("pc.", StringComparison.Ordinal)
        && message.Body.ValueKind == JsonValueKind.Object
        && message.Body.TryGetProperty("action", out var action)
        && action.ValueKind == JsonValueKind.String
        && string.Equals(action.GetString(), "UP", StringComparison.Ordinal);

    private static bool IsZeroOrAbsent(JsonElement body, string name) =>
        !body.TryGetProperty(name, out var value)
        || value.ValueKind == JsonValueKind.Null
        || (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && number == 0);

    private Result<OutboundEnvelope> Build(string agentId, OutboundMessage message)
    {
        if (string.IsNullOrWhiteSpace(agentId) || string.IsNullOrWhiteSpace(message.Type))
        {
            return Result.Failure<OutboundEnvelope>(AgentErrors.InvalidMessage("Agente e tipo da mensagem são obrigatórios."));
        }

        var created = factory.Create(
            message.Type, agentId, correlationId: null, message.Body, message.OperationId, message.DeviceId, message.DeviceName);
        if (created.IsFailure)
        {
            // Erro de programação de quem chama: registra o tipo e o código, nunca o corpo.
            LogOutboundRejected(agentId, message.Type, created.Error.Code);
            return Result.Failure<OutboundEnvelope>(AgentErrors.InvalidMessage("A mensagem não cumpre o contrato do agente."));
        }

        return created;
    }

    /// <summary>
    /// O mesmo comando (mesmo <c>id</c>, que a espera da resposta já aguarda) com o <c>ts</c> de agora. O agente mede a idade
    /// de uma tecla desde o <c>ts</c>: carimbada antes de esperar a sessão voltar, toda tecla de uma reconexão curta (deploy)
    /// chegaria velha e seria descartada. Daqui em diante a fila da sessão conta, e o agente parado continua protegido.
    /// </summary>
    private byte[] Restamp(string agentId, OutboundMessage message, OutboundEnvelope envelope)
    {
        var created = factory.Create(
            message.Type, agentId, correlationId: null, message.Body, message.OperationId, message.DeviceId, message.DeviceName,
            envelope.Id);
        return created.IsSuccess ? created.Value.Json : envelope.Json;
    }

    /// <param name="pending">A espera do comando (pedido/resposta); nula no envio sem resposta. Só se envia se ela ainda não falhou.</param>
    /// <param name="cancellationToken">Cancela a espera por sessão: o do chamador e o da falha da espera.</param>
    /// <param name="callerToken">O do chamador: quando é ele que cancela, o cancelamento sobe como sempre.</param>
    private async Task<bool> DeliverAsync(
        string agentId,
        OutboundMessage message,
        OutboundEnvelope envelope,
        bool droppable,
        IPendingReply? pending,
        CancellationToken cancellationToken,
        CancellationToken callerToken)
    {
        var delivery = message.Delivery;
        // Com a sessão de pé, o envelope acabou de ser montado: o `ts` dele já é o da saída.
        if (connections.TryGet(agentId, out var connected)
            && (pending is null || pending.TryBeginSend(connected))
            && await connected.SendAsync(envelope.Json, droppable, cancellationToken))
        {
            return true;
        }

        // Quem age no PC ao vivo (mouse, teclado, energia) só espera uma volta MUITO curta e só se o agente acabou de cair
        // (a presença ainda está na graça): a troca de instância na publicação o faz reconectar em menos de um segundo, e o
        // comando que coincidiu com ela não deve falhar. Passado o prazo curto o que fosse enviado depois chegaria junto,
        // mais tarde, e cairia em outra janela: falha como "reconectando". Agente que já estava fora do ar falha na hora.
        var wait = options.Value.ReconnectGrace;
        if (delivery == AgentDelivery.Immediate)
        {
            if (!connections.IsInGrace(agentId))
            {
                return false;
            }

            wait = options.Value.ImmediateReconnectWait;
        }

        // Deploys e quedas breves do socket levam o agente a reconectar em cerca de dois segundos. Esperar esta
        // janela evita responder `agent_offline` para o comando que coincidiu com a troca, sem reter filas longas.
        IAgentSession? session;
        try
        {
            session = await connections.WaitForSessionAsync(agentId, wait, time, cancellationToken);
        }
        catch (OperationCanceledException) when (!callerToken.IsCancellationRequested)
        {
            // A espera do comando falhou enquanto ele aguardava uma sessão: não há mais a quem entregar.
            return false;
        }

        // Depois da espera, o carimbo é refeito: a idade da tecla conta da saída para o agente, não do pedido.
        return session is not null
            && (pending is null || pending.TryBeginSend(session))
            && await session.SendAsync(Restamp(agentId, message, envelope), droppable, cancellationToken);
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Comando {Type} ao agente {AgentId} ({CommandId}) sem resposta no prazo; resposta tardia será descartada.")]
    private partial void LogRequestTimedOut(string agentId, string type, Guid commandId);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Comando {Type} ao agente {AgentId} recusado na hora: o agente está conectado, mas não responde.")]
    private partial void LogStalledFastFail(string agentId, string type);

    [LoggerMessage(Level = LogLevel.Error, Message = "Mensagem de saída {Type} para o agente {AgentId} recusada pelo contrato ({Reason}).")]
    private partial void LogOutboundRejected(string agentId, string type, string reason);
}
