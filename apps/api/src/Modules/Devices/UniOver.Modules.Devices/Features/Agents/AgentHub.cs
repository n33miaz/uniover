using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.AgentProtocol;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Presence;
using UniOver.Modules.Devices.Features.RemoteCare;
using UniOver.Modules.Devices.Ports;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Features.Agents;

/// <summary>
/// O núcleo do transporte: recebe uma sessão já autenticada (de qualquer adaptador) e a conduz até o fim. Registra a
/// presença, faz valer um dono da conexão por agente, e valida <b>cada</b> mensagem contra o contrato antes de
/// qualquer efeito (inclusive o de anotar que o agente falou). Não conhece WebSocket, MQTT nem HTTP.
/// </summary>
internal sealed partial class AgentHub(
    AgentEnvelopeValidator validator,
    OutboundEnvelopeFactory factory,
    AgentConnections connections,
    AgentPresencePersistence persistedPresence,
    IReplyCorrelator correlator,
    IAgentLogReports logReports,
    IServiceScopeFactory scopes,
    IOptions<DevicesTransportOptions> options,
    TimeProvider time,
    ILogger<AgentHub> logger)
{
    private const string InvalidMessageText = "A mensagem não cumpre o contrato.";
    private const string KeepAliveCapability = "transport.keepalive.v1";
    private const string AgentKeepAliveType = "agent.keepalive.v1";
    private const string ApiKeepAliveType = "api.keepalive.v1";

    public async Task RunSessionAsync(IAgentSession session, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(session);

        var agentId = session.AgentId;
        var closeReason = AgentCloseReason.Normal;

        var connectedAt = time.GetUtcNow();
        var previous = connections.Attach(session, connectedAt);
        await persistedPresence.RecordConnectedAsync(agentId, connectedAt, cancellationToken);
        using var heartbeatStop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var heartbeat = SendKeepAlivesAsync(session, heartbeatStop.Token);
        LogConnected(agentId);
        try
        {
            if (previous is not null)
            {
                // Um dono da conexão por agente: a antiga sai com o motivo "replaced" (o agente que foi substituído
                // não deve reconectar em loop disputando a vaga).
                LogReplaced(agentId);
                await CloseQuietlyAsync(previous, AgentCloseReason.Replaced);
            }

            var refusals = new Queue<DateTimeOffset>();
            while (true)
            {
                var frame = await session.ReceiveAsync(cancellationToken);
                if (frame is null)
                {
                    break;
                }

                if (!await ProcessAsync(session, frame, refusals, cancellationToken))
                {
                    closeReason = AgentCloseReason.PolicyViolation;
                    break;
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            closeReason = AgentCloseReason.Shutdown;
        }
        catch (OperationCanceledException)
        {
            // O transporte pode cancelar uma leitura quando o proxy corta o socket. Não é falha interna da sessão.
            closeReason = AgentCloseReason.Normal;
        }
        catch (Exception ex)
        {
            closeReason = AgentCloseReason.InternalError;
            LogSessionFailed(agentId, ex.GetType().Name);
        }
        finally
        {
            await heartbeatStop.CancelAsync();
            await AwaitKeepAliveAsync(heartbeat);
            // Só a dona da conexão derruba a presença; quem foi substituída sai sem mexer (ver AgentConnections).
            var disconnectedAt = time.GetUtcNow();
            if (connections.Detach(session, disconnectedAt))
            {
                correlator.FailAll(agentId);
                await persistedPresence.RecordDisconnectedAsync(agentId, disconnectedAt, CancellationToken.None);
            }

            LogDisconnected(agentId, closeReason);
            await CloseQuietlyAsync(session, closeReason);
            await session.DisposeAsync();
        }
    }

    /// <summary>Devolve <c>false</c> quando a sessão deve ser fechada por insistência em mensagens recusadas.</summary>
    private async Task<bool> ProcessAsync(
        IAgentSession session, byte[] frame, Queue<DateTimeOffset> refusals, CancellationToken cancellationToken)
    {
        var agentId = session.AgentId;

        // Primeiro o contrato, antes de qualquer efeito: nada do que o agente mandou é tratado sem passar por aqui.
        var validation = validator.Validate(frame);
        if (validation.IsFailure)
        {
            return await RefuseAsync(session, frame, validation.Error.Code, refusals, cancellationToken);
        }

        var envelope = validation.Value;
        if (!AgentMessageDirections.FromAgent.Contains(envelope.Type))
        {
            return await RefuseAsync(session, frame, "wrong_direction", refusals, cancellationToken);
        }

        // Impede o agente de se passar por outro (o slug vem do token, não do que ele escreve).
        if (!string.Equals(envelope.Source, $"agent:{agentId}", StringComparison.Ordinal))
        {
            return await RefuseAsync(session, frame, "source_mismatch", refusals, cancellationToken);
        }

        if (!string.Equals(envelope.Target, OutboundEnvelopeFactory.ApiEndpoint, StringComparison.Ordinal))
        {
            return await RefuseAsync(session, frame, "target_mismatch", refusals, cancellationToken);
        }

        var now = time.GetUtcNow();
        connections.Touch(session, now);
        var isCurrent = connections.IsCurrent(session);
        if (isCurrent && envelope.Type is not AgentMessageTypes.AgentHelloV1 and not AgentMessageTypes.AgentUpdateStatusV1)
        {
            await persistedPresence.TouchAsync(agentId, now, cancellationToken);
        }

        switch (envelope.Type)
        {
            case AgentMessageTypes.AgentHelloV1:
            {
                var version = envelope.Body.GetProperty("agentVersion").GetString()!;
                var capabilities = envelope.Body.GetProperty("capabilities").EnumerateArray()
                    .Select(c => c.GetString()!)
                    .ToArray();
                var host = ReadHost(envelope.Body);
                var update = envelope.Body.TryGetProperty("update", out var updateElement)
                    ? ReadUpdate(updateElement)
                    : null;
                connections.RecordHello(
                    session,
                    version,
                    capabilities,
                    now,
                    host,
                    update);
                if (isCurrent)
                {
                    await persistedPresence.RecordHelloAsync(agentId, version, host, update, now, cancellationToken);
                }

                break;
            }

            case AgentMessageTypes.AgentUpdateStatusV1:
            {
                var status = ReadUpdate(envelope.Body);
                connections.RecordUpdate(session, status, now);
                if (isCurrent)
                {
                    await persistedPresence.RecordUpdateAsync(agentId, status, now, cancellationToken);
                }

                break;
            }

            case AgentMessageTypes.AgentLogsV1:
                CompleteLogs(agentId, envelope);
                break;

            case AgentKeepAliveType:
                break;

            case AgentMessageTypes.CommandResultV1:
                CompleteRequest(agentId, envelope);
                break;

            default:
                await DispatchAsync(agentId, envelope, cancellationToken);
                break;
        }

        return true;
    }

    /// <summary>Os campos opcionais do <c>hello</c> que a tela do administrador mostra; já passaram pelo contrato (tamanho e forma).</summary>
    private static AgentHostInfo? ReadHost(JsonElement body)
    {
        var os = body.TryGetProperty("os", out var osElement) ? osElement.GetString() : null;
        string? kind = null;
        string? host = null;
        if (body.TryGetProperty("tv", out var tv) && tv.ValueKind == JsonValueKind.Object)
        {
            kind = tv.GetProperty("kind").GetString();
            host = tv.GetProperty("host").GetString();
        }

        return os is null && kind is null ? null : new AgentHostInfo(os, kind, host);
    }

    /// <summary>O estado da auto-atualização (<c>update</c> do <c>hello</c> ou corpo de <c>agent.update.status.v1</c>); já passou pelo contrato.</summary>
    private static AgentUpdateInfo ReadUpdate(JsonElement body)
    {
        string? Text(string name) => body.TryGetProperty(name, out var value) ? value.GetString() : null;
        DateTimeOffset? Time(string name) => body.TryGetProperty(name, out var value) ? value.GetDateTimeOffset() : null;

        return new AgentUpdateInfo(
            body.GetProperty("outcome").GetString()!,
            Text("installedSha"),
            Time("installedAt"),
            Text("latestSha"),
            Time("checkedAt"),
            Time("nextCheckAt"),
            Text("reason"),
            Text("blockedSha"),
            Text("previousSha"),
            body.TryGetProperty("rolledBack", out var rolledBack) && rolledBack.GetBoolean());
    }

    /// <summary>
    /// O registro do agente chega antes do resultado do comando e é entregue a quem o pediu, pelo <c>requestId</c> e
    /// pelo agente. O texto nunca vai para o log da API.
    /// </summary>
    private void CompleteLogs(string agentId, ValidatedEnvelope envelope)
    {
        var body = envelope.Body;
        var report = new AgentLogReport(
            body.GetProperty("text").GetString()!,
            body.GetProperty("lines").GetInt32(),
            body.GetProperty("truncated").GetBoolean(),
            body.GetProperty("at").GetDateTimeOffset());
        if (!logReports.Complete(agentId, body.GetProperty("requestId").GetGuid(), report))
        {
            LogLogsDiscarded(agentId);
        }
    }

    private void CompleteRequest(string agentId, ValidatedEnvelope envelope)
    {
        // O esquema exige correlationId neste tipo.
        var commandId = envelope.CorrelationId!.Value;
        var ok = envelope.Body.GetProperty("ok").GetBoolean();
        Error? error = null;
        if (!ok && envelope.Body.TryGetProperty("error", out var failure))
        {
            error = new Error(failure.GetProperty("code").GetString()!, failure.GetProperty("message").GetString()!);
        }

        if (!correlator.TryComplete(agentId, commandId, new AgentReply(commandId, ok, error)))
        {
            // Atrasada (o prazo já passou), repetida ou de um comando que não é deste agente: não há quem espere.
            LogReplyDiscarded(agentId, commandId);
        }
    }

    private async Task DispatchAsync(string agentId, ValidatedEnvelope envelope, CancellationToken cancellationToken)
    {
        // Um escopo por mensagem: a conexão dura horas e os tratadores podem depender de serviços com escopo.
        using var scope = scopes.CreateScope();
        var handlers = scope.ServiceProvider.GetServices<IAgentMessageHandler>()
            .Where(h => h.HandledTypes.Contains(envelope.Type))
            .ToList();
        if (handlers.Count == 0)
        {
            // Mensagem válida que ninguém trata ainda (ex.: estado da TV antes do módulo existir): só registra e descarta.
            LogUnhandled(agentId, envelope.Type);
            return;
        }

        var message = new InboundMessage(
            agentId, envelope.Id, envelope.Type, envelope.CorrelationId, envelope.Timestamp, envelope.Body);
        foreach (var handler in handlers)
        {
            try
            {
                await handler.HandleAsync(message, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                // Falha de quem trata não derruba a conexão do agente nem impede os outros tratadores.
                LogHandlerFailed(agentId, envelope.Type, ex.GetType().Name);
            }
        }
    }

    private async Task<bool> RefuseAsync(
        IAgentSession session, byte[] frame, string reason, Queue<DateTimeOffset> refusals, CancellationToken cancellationToken)
    {
        var agentId = session.AgentId;
        var (type, correlationId) = Peek(frame);

        // Registra agente, tipo e motivo; nunca o corpo recebido.
        LogRefused(agentId, type ?? "(desconhecido)", reason);

        if (correlationId is { } correlation)
        {
            await ReplyInvalidAsync(session, correlation, cancellationToken);
        }

        var settings = options.Value;
        var now = time.GetUtcNow();
        while (refusals.Count > 0 && refusals.Peek() <= now - settings.RefusalWindow)
        {
            refusals.Dequeue();
        }

        refusals.Enqueue(now);
        if (refusals.Count <= settings.RefusalLimit)
        {
            return true;
        }

        LogTooManyRefusals(agentId);
        return false;
    }

    private async Task ReplyInvalidAsync(IAgentSession session, Guid correlationId, CancellationToken cancellationToken)
    {
        var body = new JsonObject
        {
            ["ok"] = false,
            ["error"] = new JsonObject
            {
                ["code"] = AgentErrors.InvalidMessageCode,
                ["message"] = InvalidMessageText,
            },
        };

        var reply = factory.Create(
            AgentMessageTypes.CommandResultV1, session.AgentId, correlationId, JsonSerializer.SerializeToElement(body));
        if (reply.IsSuccess)
        {
            await session.SendAsync(reply.Value.Json, cancellationToken);
        }
    }

    private async Task SendKeepAlivesAsync(IAgentSession session, CancellationToken cancellationToken)
    {
        try
        {
            while (true)
            {
                await Task.Delay(options.Value.ApplicationKeepAlive, time, cancellationToken);
                if (!connections.Supports(session, KeepAliveCapability))
                {
                    continue;
                }

                var heartbeat = factory.Create(
                    ApiKeepAliveType, session.AgentId, correlationId: null,
                    JsonSerializer.SerializeToElement(new JsonObject()));
                if (heartbeat.IsFailure || !await session.SendAsync(heartbeat.Value.Json, cancellationToken))
                {
                    return;
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Encerramento normal da sessão.
        }
        catch (Exception ex)
        {
            // Um batimento nunca derruba a sessão nem vira fechamento 1011.
            LogKeepAliveFailed(session.AgentId, ex.GetType().Name);
        }
    }

    private static async Task AwaitKeepAliveAsync(Task heartbeat)
    {
        try
        {
            await heartbeat;
        }
        catch (OperationCanceledException)
        {
            // O cancelamento já foi pedido no encerramento da sessão.
        }
    }

    /// <summary>
    /// Leitura tolerante só para responder e registrar: o tipo (só se tem a forma de um tipo, para não injetar texto
    /// do agente no log) e o <c>correlationId</c> (só se for um UUID bem formado).
    /// </summary>
    private static (string? Type, Guid? CorrelationId) Peek(byte[] frame)
    {
        try
        {
            using var document = JsonDocument.Parse(frame);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return (null, null);
            }

            string? type = null;
            if (root.TryGetProperty("type", out var typeElement)
                && typeElement.ValueKind == JsonValueKind.String
                && typeElement.GetString() is { Length: <= 64 } candidate
                && TypePattern().IsMatch(candidate))
            {
                type = candidate;
            }

            Guid? correlation = null;
            if (root.TryGetProperty("correlationId", out var correlationElement)
                && correlationElement.ValueKind == JsonValueKind.String
                && Guid.TryParse(correlationElement.GetString(), out var parsed))
            {
                correlation = parsed;
            }

            return (type, correlation);
        }
        catch (JsonException)
        {
            return (null, null);
        }
    }

    private async Task CloseQuietlyAsync(IAgentSession session, AgentCloseReason reason)
    {
        try
        {
            await session.CloseAsync(reason, CancellationToken.None);
        }
        catch (Exception ex)
        {
            LogCloseFailed(session.AgentId, ex.GetType().Name);
        }
    }

    [GeneratedRegex("^[a-z]+([.][a-z]+)+[.]v[0-9]+$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex TypePattern();

    [LoggerMessage(Level = LogLevel.Information, Message = "Agente {AgentId} conectado.")]
    private partial void LogConnected(string agentId);

    [LoggerMessage(Level = LogLevel.Information, Message = "Agente {AgentId} desconectado ({Reason}).")]
    private partial void LogDisconnected(string agentId, AgentCloseReason reason);

    [LoggerMessage(Level = LogLevel.Information, Message = "Agente {AgentId} reconectou: a conexão anterior foi substituída.")]
    private partial void LogReplaced(string agentId);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Mensagem do agente {AgentId} recusada: tipo {Type}, motivo {Reason}.")]
    private partial void LogRefused(string agentId, string type, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Agente {AgentId} fechado por recusas demais em pouco tempo.")]
    private partial void LogTooManyRefusals(string agentId);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Resposta {CommandId} do agente {AgentId} descartada: ninguém espera por ela (tardia, repetida ou de outro agente).")]
    private partial void LogReplyDiscarded(string agentId, Guid commandId);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Registro do agente {AgentId} descartado: ninguém espera por ele (tardio, repetido ou de outro agente).")]
    private partial void LogLogsDiscarded(string agentId);

    [LoggerMessage(Level = LogLevel.Debug, Message = "Mensagem {Type} do agente {AgentId} descartada: nenhum tratador registrado.")]
    private partial void LogUnhandled(string agentId, string type);

    // Nos três abaixo só o tipo do erro: o tratador pode ter falhado no banco, e a mensagem do driver cita servidor e conexão.
    [LoggerMessage(Level = LogLevel.Error, Message = "Tratador falhou ao processar {Type} do agente {AgentId} ({ErrorType}).")]
    private partial void LogHandlerFailed(string agentId, string type, string errorType);

    [LoggerMessage(Level = LogLevel.Error, Message = "Falha ao conduzir a sessão do agente {AgentId} ({ErrorType}).")]
    private partial void LogSessionFailed(string agentId, string errorType);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Falha ao fechar a sessão do agente {AgentId} ({ErrorType}).")]
    private partial void LogCloseFailed(string agentId, string errorType);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Batimento da sessão do agente {AgentId} interrompido ({ErrorType}).")]
    private partial void LogKeepAliveFailed(string agentId, string errorType);
}
