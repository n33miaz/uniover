using Microsoft.Extensions.Logging;
using UniOver.BuildingBlocks.Messaging;
using UniOver.Modules.Devices.Contracts.Pairing;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Ports;

namespace UniOver.Modules.Devices.Features.Events;

/// <summary>
/// Quando um agente é revogado, fecha a conexão viva dele: o token deixa de valer para novas conexões na hora,
/// mas quem já estava conectado continuaria falando até cair por conta própria. A entrega do evento é "pelo menos
/// uma vez"; fechar uma sessão que já fechou não faz nada, então não precisa de inbox.
/// </summary>
internal sealed partial class AgentRevokedSessionCloser(AgentConnections connections, ILogger<AgentRevokedSessionCloser> logger)
    : IIntegrationEventHandler<AgentRevoked>
{
    public async Task HandleAsync(AgentRevoked integrationEvent, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(integrationEvent);

        if (connections.TryGet(integrationEvent.Slug, out var session))
        {
            LogClosing(integrationEvent.Slug);
            await session.CloseAsync(AgentCloseReason.Revoked, cancellationToken);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Agente {AgentId} revogado: fechando a conexão viva.")]
    private partial void LogClosing(string agentId);
}
