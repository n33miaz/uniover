using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Entrega os comandos pelo <see cref="IAgentGateway"/> do Devices (pela interface de <c>*.Contracts</c>): amanhã o
/// agente pode estar atrás de outro transporte ou de outro deploy sem mudar nada aqui.
/// </summary>
internal sealed class DevicesGatewayCommandSender(IAgentGateway gateway, TimeProvider time) : ITvCommandSender
{
    public async Task<TvSendOutcome> RequestAsync(
        string agentId, TvMessage message, TimeSpan timeout, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(message);

        var started = time.GetTimestamp();
        var result = await gateway.RequestAsync(agentId, new OutboundMessage(message.Type, message.Body), timeout, cancellationToken);
        var elapsed = Elapsed(started);

        if (result.IsFailure)
        {
            return Map(result.Error.Code, elapsed);
        }

        var reply = result.Value;
        return reply.Ok
            ? TvSendOutcome.Ok(elapsed)
            : TvSendOutcome.Failed(TvSendStatus.CommandFailed, reply.Error?.Code, reply.Error?.Message, elapsed);
    }

    public async Task<TvSendOutcome> PostAsync(string agentId, TvMessage message, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(message);

        var started = time.GetTimestamp();
        var result = await gateway.SendAsync(agentId, new OutboundMessage(message.Type, message.Body), cancellationToken);
        var elapsed = Elapsed(started);
        return result.IsSuccess ? TvSendOutcome.Ok(elapsed) : Map(result.Error.Code, elapsed);
    }

    private TimeSpan Elapsed(long started)
    {
        var elapsed = time.GetElapsedTime(started);
        return elapsed < TimeSpan.Zero ? TimeSpan.Zero : elapsed;
    }

    private static TvSendOutcome Map(string code, TimeSpan elapsed) => code switch
    {
        AgentErrors.OfflineCode => TvSendOutcome.Failed(TvSendStatus.AgentOffline, code, latency: elapsed),
        AgentErrors.TimeoutCode => TvSendOutcome.Failed(TvSendStatus.AgentTimeout, code, latency: elapsed),
        _ => TvSendOutcome.Failed(TvSendStatus.InvalidMessage, code, latency: elapsed),
    };
}

/// <summary>Presença do agente lida do Devices (só em memória, nunca vai ao banco).</summary>
internal sealed class DevicesAgentPresence(IAgentPresenceReader presence, TimeProvider time) : ITvAgentPresence
{
    public bool IsOnline(string agentId) => !string.IsNullOrEmpty(agentId) && presence.Get(agentId)?.Connected == true;

    public bool IsOfflineBeyondReconnectGrace(string agentId) =>
        !string.IsNullOrEmpty(agentId)
        && presence.OfflineSince(agentId) is { } since
        && time.GetUtcNow() - since > presence.ReconnectGrace;
}
