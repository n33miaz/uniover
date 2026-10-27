using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;

namespace UniOver.Modules.Devices.Features.RemoteCare;

/// <summary>
/// <c>update</c> (atualizar agora; o agente só reinicia se houver versão nova), <c>restart</c> (reiniciar o agente) ou
/// <c>rollback</c> (voltar para a versão anterior guardada no PC, bloqueando a que sai).
/// </summary>
internal sealed record AgentMaintenanceRequest(string? Action);

internal sealed record AgentMaintenanceResponse(string Action, bool Accepted);

internal sealed record AgentMaintenanceCommand(Guid UserId, Guid AgentId, AgentMaintenanceV1BodyAction Action, ClientInfo Client);

internal sealed class AgentMaintenanceHandler(
    RemoteCareResolver resolver,
    IAgentGateway gateway,
    IAgentPresenceReader presence,
    PairingAuditWriter audit,
    DevicesDbContext db)
{
    /// <summary>O agente só entrega o pedido ao supervisor do PC e responde.</summary>
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);

    public static string WireName(AgentMaintenanceV1BodyAction action) => action switch
    {
        AgentMaintenanceV1BodyAction.Update => "update",
        AgentMaintenanceV1BodyAction.Rollback => "rollback",
        _ => "restart",
    };

    public async Task<IResult> HandleAsync(AgentMaintenanceCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var target = await resolver.ResolveAsync(command.AgentId, RemoteCareDefaults.MaintenanceCapability, cancellationToken);
        if (!target.IsReady)
        {
            return target.Failure!;
        }

        // Voltar atrás só faz sentido com uma versão guardada; quem a conta é o agente (um agente antigo nunca conta).
        if (command.Action == AgentMaintenanceV1BodyAction.Rollback && presence.Get(target.Slug)?.Update?.PreviousSha is null)
        {
            return RemoteCareProblems.NoPreviousVersion();
        }

        var reply = await gateway.RequestAsync(
            target.Slug,
            new OutboundMessage(AgentMessageTypes.AgentMaintenanceV1, RemoteCareDefaults.MaintenanceBody(command.Action)),
            RequestTimeout,
            cancellationToken);
        if (reply.IsFailure)
        {
            return RemoteCareProblems.FromGateway(reply.Error);
        }

        if (!reply.Value.Ok)
        {
            return RemoteCareProblems.CommandFailed(reply.Value.Error?.Code);
        }

        // Só entra na trilha o que o agente confirmou ter entregue ao supervisor: pedido recusado, sem agente ou sem
        // resposta não mudou nada no PC.
        var eventName = command.Action switch
        {
            AgentMaintenanceV1BodyAction.Update => PairingEvents.AgentUpdateRequested,
            AgentMaintenanceV1BodyAction.Rollback => PairingEvents.AgentRollbackRequested,
            _ => PairingEvents.AgentRestartRequested,
        };
        audit.Add(eventName, command.Client, agentId: target.Id, userId: command.UserId);
        await db.SaveChangesAsync(cancellationToken);
        return TypedResults.Ok(new AgentMaintenanceResponse(WireName(command.Action), true));
    }
}

internal static class AgentMaintenanceEndpoint
{
    public static void MapAgentMaintenance(this IEndpointRouteBuilder group) =>
        group.MapPost("/agents/{id:guid}/maintenance", HandleAsync)
            .RequireAuthorization(StepUp.Policy(RemoteCareDefaults.StepUpAction))
            .RequireRateLimiting(RateLimitPolicies.Maintenance)
            .RequireIdempotency<DevicesDbContext>()
            .Produces<AgentMaintenanceResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

    private static async Task<IResult> HandleAsync(
        Guid id,
        ICurrentUser current,
        HttpContext http,
        AgentMaintenanceRequest? request,
        AgentMaintenanceHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        AgentMaintenanceV1BodyAction? action = request?.Action switch
        {
            "update" => AgentMaintenanceV1BodyAction.Update,
            "restart" => AgentMaintenanceV1BodyAction.Restart,
            "rollback" => AgentMaintenanceV1BodyAction.Rollback,
            _ => null,
        };
        if (action is not { } chosen)
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["action"] = ["Escolha update, restart ou rollback."],
            });
        }

        return await handler.HandleAsync(new AgentMaintenanceCommand(userId, id, chosen, ClientInfo.From(http)), cancellationToken);
    }
}
