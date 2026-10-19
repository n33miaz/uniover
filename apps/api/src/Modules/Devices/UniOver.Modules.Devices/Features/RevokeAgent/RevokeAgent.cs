using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Pairing;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Features.Tokens;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Features.RevokeAgent;

internal sealed record RevokeAgentRequest(string? Reason);

internal sealed record RevokeAgentCommand(Guid UserId, Guid AgentId, string? Reason, ClientInfo Client);

internal sealed record RevokeAgentResponse(Guid Id, bool Revoked);

internal sealed class RevokeAgentHandler(
    DevicesDbContext db,
    IEventBus events,
    IDeviceTokenCache cache,
    PairingAuditWriter audit,
    TimeProvider time)
{
    /// <summary><c>false</c> quando o agente não existe. Revogar de novo um revogado é sucesso e não repete evento nem auditoria.</summary>
    public async Task<bool> HandleAsync(RevokeAgentCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var agent = await db.Agents.SingleOrDefaultAsync(a => a.Id == command.AgentId, cancellationToken);
        if (agent is null)
        {
            return false;
        }

        var now = time.GetUtcNow();
        if (agent.Revoke(now, command.UserId, command.Reason))
        {
            audit.Add(PairingEvents.AgentRevoked, command.Client, agentId: agent.Id, userId: command.UserId);
            await events.PublishAsync(new AgentRevoked(IdGenerator.NewId(), now, agent.Id, agent.Slug), cancellationToken);
            await db.SaveChangesAsync(cancellationToken);
        }

        // Também direto, sem esperar o despachante: o token não pode sobreviver nem aos poucos segundos da entrega.
        cache.Invalidate(agent.Id);
        return true;
    }
}

internal static class RevokeAgentEndpoint
{
    // Revogar é ação protetora (tira poder do agente): só pede login, sem passkey.
    public static void MapRevokeAgent(this IEndpointRouteBuilder group) =>
        group.MapPost("/agents/{id:guid}/revoke", HandleAsync).RequireAuthorization()
            .Produces<RevokeAgentResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound);

    private static async Task<IResult> HandleAsync(
        Guid id,
        ICurrentUser current,
        HttpContext http,
        RevokeAgentRequest? request,
        RevokeAgentHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return PairingProblems.Unauthenticated();
        }

        var reason = request?.Reason?.Trim();
        if (reason is { Length: > Agent.ReasonMax })
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["reason"] = [$"O motivo deve ter no máximo {Agent.ReasonMax} caracteres."],
            });
        }

        return await handler.HandleAsync(new RevokeAgentCommand(userId, id, reason, ClientInfo.From(http)), cancellationToken)
            ? TypedResults.Ok(new RevokeAgentResponse(id, true))
            : TypedResults.NotFound();
    }
}
