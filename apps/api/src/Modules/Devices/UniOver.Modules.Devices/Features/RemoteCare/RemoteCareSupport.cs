using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Persistence;

namespace UniOver.Modules.Devices.Features.RemoteCare;

/// <summary>
/// Manutenção remota de um agente, só do administrador: o que a API precisa saber do agente para decidir se o pedido
/// faz sentido (existe, não foi revogado, está conectado e sabe fazer o que se pede) antes de mexer no canal dele.
/// </summary>
internal static class RemoteCareDefaults
{
    /// <summary>Capacidade do <c>hello</c> de quem sabe devolver o próprio registro.</summary>
    public const string LogsCapability = "agent.logs.v1";

    /// <summary>Capacidade do <c>hello</c> de quem entende atualizar e reiniciar pelo supervisor.</summary>
    public const string MaintenanceCapability = "agent.maintenance.v1";

    /// <summary>Ação de confirmação (passkey) das duas ações que mexem no PC do amigo à distância.</summary>
    public const string StepUpAction = "devices.agent-maintenance";

    /// <summary>Quantas linhas do registro vêm quando o pedido não diz (e o máximo do contrato).</summary>
    public const int DefaultLines = 300;

    public const int MaxLines = 1000;

    public static JsonElement LogsRequestBody(Guid requestId, int lines) =>
        BodyOf(new AgentLogsRequestV1Message { Body = new AgentLogsRequestV1Body { RequestId = requestId, Lines = lines } }.ToJson());

    public static JsonElement MaintenanceBody(AgentMaintenanceV1BodyAction action) =>
        BodyOf(new AgentMaintenanceV1Message { Body = new AgentMaintenanceV1Body { Action = action } }.ToJson());

    private static JsonElement BodyOf(string messageJson)
    {
        using var document = JsonDocument.Parse(messageJson);
        return document.RootElement.GetProperty("body").Clone();
    }
}

/// <summary>O agente escolhido ou o problema que já responde ao pedido.</summary>
internal readonly record struct RemoteCareTarget(Guid Id, string Slug, IResult? Failure)
{
    public bool IsReady => Failure is null;
}

internal sealed class RemoteCareResolver(DevicesDbContext db, IAgentPresenceReader presence)
{
    public async Task<RemoteCareTarget> ResolveAsync(Guid agentId, string capability, CancellationToken cancellationToken)
    {
        var agent = await db.Agents.AsNoTracking()
            .Where(a => a.Id == agentId && a.RevokedAt == null)
            .Select(a => new { a.Id, a.Slug })
            .SingleOrDefaultAsync(cancellationToken);
        if (agent is null)
        {
            return new RemoteCareTarget(agentId, string.Empty, TypedResults.NotFound());
        }

        var info = presence.Get(agent.Slug);

        // Sem o `hello` ainda (a conexão acabou de abrir) não se sabe o que o agente faz: tenta de novo daqui a pouco.
        if (info is not { Connected: true, AgentVersion: not null })
        {
            return new RemoteCareTarget(agent.Id, agent.Slug, RemoteCareProblems.Offline());
        }

        return info.Capabilities.Contains(capability, StringComparer.Ordinal)
            ? new RemoteCareTarget(agent.Id, agent.Slug, null)
            : new RemoteCareTarget(agent.Id, agent.Slug, RemoteCareProblems.Outdated());
    }
}

/// <summary>Respostas de erro da manutenção remota, com os <c>type</c> estáveis que a tela reconhece.</summary>
internal static class RemoteCareProblems
{
    public const string OfflineType = "agent-offline";
    public const string TimeoutType = "agent-timeout";
    public const string OutdatedType = "agent-outdated";
    public const string CommandFailedType = "command-failed";
    public const string LogsMissingType = "logs-missing";
    public const string BusyType = "logs-in-progress";
    public const string NoPreviousVersionType = "no-previous-version";

    public static IResult Offline() => Problem(StatusCodes.Status503ServiceUnavailable, OfflineType, "O agente não está conectado.");

    public static IResult Timeout() => Problem(StatusCodes.Status504GatewayTimeout, TimeoutType, "O agente não respondeu a tempo.");

    /// <summary>O agente está conectado, mas é de uma versão que não sabe fazer isto: a tela pede para atualizar.</summary>
    public static IResult Outdated() => Problem(StatusCodes.Status409Conflict, OutdatedType, "O agente precisa ser atualizado para isto.");

    /// <summary>Não há versão anterior guardada no PC (nunca atualizou, ou já voltou): não há para onde voltar.</summary>
    public static IResult NoPreviousVersion() =>
        Problem(StatusCodes.Status409Conflict, NoPreviousVersionType, "Este computador não guardou uma versão anterior.");

    public static IResult Busy() => Problem(StatusCodes.Status409Conflict, BusyType, "Já há um pedido de registro em andamento para este agente.");

    public static IResult LogsMissing() => Problem(StatusCodes.Status502BadGateway, LogsMissingType, "O agente não mandou o registro.");

    /// <summary>O agente respondeu, mas não conseguiu: só o código estável dele vai adiante, nunca o texto livre.</summary>
    public static IResult CommandFailed(string? agentCode) =>
        Results.Problem(
            statusCode: StatusCodes.Status502BadGateway,
            title: "O agente não conseguiu executar o pedido.",
            type: ProblemDetailsExtensions.TypeBase + CommandFailedType,
            extensions: agentCode is { Length: > 0 } ? new Dictionary<string, object?> { ["agentError"] = agentCode } : null);

    /// <summary>Falha de entrega do gateway (offline, prazo, mensagem recusada) como resposta HTTP.</summary>
    public static IResult FromGateway(UniOver.SharedKernel.Error error) => error.Code switch
    {
        AgentErrors.OfflineCode => Offline(),
        AgentErrors.TimeoutCode => Timeout(),
        _ => Problem(StatusCodes.Status500InternalServerError, "internal-error", "Não foi possível montar o pedido."),
    };

    public static IResult Unauthenticated() =>
        Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Sessão inválida ou expirada.");

    private static IResult Problem(int status, string type, string title) =>
        Results.Problem(statusCode: status, title: title, type: ProblemDetailsExtensions.TypeBase + type);
}
