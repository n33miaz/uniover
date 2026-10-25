using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Features.RemoteCare;

/// <summary>Quantas linhas do fim do registro; omitido vale <see cref="RemoteCareDefaults.DefaultLines"/>.</summary>
internal sealed record AgentLogsRequest(int? Lines);

/// <summary>
/// O fim do registro do agente, já sem segredos (o agente os remove antes de enviar). <c>Truncated</c> diz que o agente
/// cortou as linhas mais antigas para caber no limite do canal.
/// </summary>
internal sealed record AgentLogsResponse(string Text, int Lines, bool Truncated, DateTimeOffset At);

internal sealed record AgentLogsCommand(Guid UserId, Guid AgentId, int Lines, ClientInfo Client);

internal sealed class AgentLogsHandler(
    RemoteCareResolver resolver,
    IAgentGateway gateway,
    IAgentLogReports reports,
    PairingAuditWriter audit,
    DevicesDbContext db)
{
    /// <summary>Quanto esperar o agente: ele só lê um arquivo local e responde.</summary>
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);

    /// <summary>Folga para o relatório chegar depois do resultado do comando (o agente o manda antes, em ordem).</summary>
    public static readonly TimeSpan ReportGrace = TimeSpan.FromSeconds(2);

    public async Task<IResult> HandleAsync(AgentLogsCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var target = await resolver.ResolveAsync(command.AgentId, RemoteCareDefaults.LogsCapability, cancellationToken);
        if (!target.IsReady)
        {
            return target.Failure!;
        }

        using var ticket = reports.TryBegin(target.Slug);
        if (ticket is null)
        {
            return RemoteCareProblems.Busy();
        }

        var reply = await gateway.RequestAsync(
            target.Slug,
            new OutboundMessage(AgentMessageTypes.AgentLogsRequestV1, RemoteCareDefaults.LogsRequestBody(ticket.RequestId, command.Lines)),
            AgentLogsHandler.RequestTimeout,
            cancellationToken);
        if (reply.IsFailure)
        {
            return RemoteCareProblems.FromGateway(reply.Error);
        }

        if (!reply.Value.Ok)
        {
            return RemoteCareProblems.CommandFailed(reply.Value.Error?.Code);
        }

        if (await ticket.WaitAsync(ReportGrace, cancellationToken) is not { } report)
        {
            return RemoteCareProblems.LogsMissing();
        }

        // Só o fato fica na trilha (quem, de onde, qual aparelho): o conteúdo do registro nunca é guardado.
        audit.Add(PairingEvents.AgentLogsViewed, command.Client, agentId: target.Id, userId: command.UserId);
        await db.SaveChangesAsync(cancellationToken);
        return TypedResults.Ok(new AgentLogsResponse(report.Text, report.Lines, report.Truncated, report.At));
    }
}

internal static class AgentLogsEndpoint
{
    public static void MapAgentLogs(this IEndpointRouteBuilder group) =>
        group.MapPost("/agents/{id:guid}/logs", HandleAsync)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .RequireRateLimiting(RateLimitPolicies.Maintenance)
            .Produces<AgentLogsResponse>()
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
        AgentLogsRequest? request,
        AgentLogsHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        var lines = request?.Lines ?? RemoteCareDefaults.DefaultLines;
        if (lines is < 1 or > RemoteCareDefaults.MaxLines)
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["lines"] = [$"Peça entre 1 e {RemoteCareDefaults.MaxLines} linhas."],
            });
        }

        // O registro é do administrador e já chega sem segredos, mas não deve ficar em cache de navegador nem de proxy.
        http.Response.Headers.CacheControl = "no-store";
        return await handler.HandleAsync(new AgentLogsCommand(userId, id, lines, ClientInfo.From(http)), cancellationToken);
    }
}
