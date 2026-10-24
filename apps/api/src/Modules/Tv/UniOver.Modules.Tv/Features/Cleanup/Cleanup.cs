using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Cleanup;

internal sealed record CleanupCommand(TvCommandOrigin Origin, Guid TvId = default);

/// <summary>
/// Resposta de uma limpeza que rodou: o que o agente relatou. A memória é em MB e some (<c>null</c>) quando a TV não
/// deixou ler; <c>FreedMb</c> nunca é negativo e também é nulo se faltou uma das duas leituras. <c>FailedSteps</c> são
/// as etapas que não deram certo (a limpeza segue nas demais).
/// </summary>
internal sealed record TvCleanupOk(
    bool Ok,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int LatencyMs,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int ClosedApps,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? FreedMb,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? MemoryBeforeMb,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? MemoryAfterMb,
    IReadOnlyList<string> FailedSteps);

/// <summary>Como terminou: já havia outra limpeza, o agente não executou, ou o relatório que prova o que fez.</summary>
internal sealed record CleanupResult(bool Busy, TvSendOutcome? Outcome, TvCleanupReport? Report);

internal sealed class CleanupHandler(TvCommandRunner runner, ITvCleanupReports reports, IOptions<TvModuleOptions> options)
{
    /// <summary>
    /// Folga para o relatório chegar depois do resultado do comando. O agente o manda antes e o Devices trata os quadros
    /// de um agente em ordem, então normalmente já está guardado; a folga só cobre uma ordem trocada.
    /// </summary>
    public static readonly TimeSpan ReportGrace = TimeSpan.FromSeconds(2);

    /// <summary>Código com que o agente recusa um pedido que chegou com outra limpeza rodando.</summary>
    public const string AgentBusyCode = "cleanup_in_progress";

    public async Task<CleanupResult> HandleAsync(CleanupCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        // Uma limpeza por TV: a vez só volta quando esta termina, com ou sem erro.
        using var ticket = reports.TryBegin(command.TvId);
        if (ticket is null)
        {
            return new CleanupResult(true, null, null);
        }

        // Tempo próprio, maior que o dos outros comandos: o agente fecha apps e mede a memória antes e depois.
        var outcome = await runner.RunAsync(
            command.Origin,
            TvCommandNames.Cleanup,
            null,
            TvMessages.Cleanup(ticket.RequestId),
            waitForReply: true,
            cancellationToken,
            options.Value.CleanupTimeout);
        if (!outcome.IsDelivered)
        {
            return new CleanupResult(outcome.ErrorCode == AgentBusyCode, outcome, null);
        }

        var report = await ticket.WaitAsync(ReportGrace, cancellationToken);
        return new CleanupResult(false, outcome, report);
    }
}

internal static class CleanupEndpoint
{
    public const string BusyType = "cleanup-in-progress";
    public const string ReportMissingCode = "cleanup_report_missing";

    public static void MapCleanup(this IEndpointRouteBuilder group) =>
        group.MapPost("/cleanup", HandleAsync).RequireAuthorization(TvAuth.Control)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<TvCleanupOk>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current, HttpContext http, ITvCurrentSelection selection, CleanupHandler handler, CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        return ToResult(await handler.HandleAsync(new CleanupCommand(origin, selection.Current.Id), cancellationToken));
    }

    /// <summary>Separado do HTTP para ser testado sem subir o servidor.</summary>
    internal static IResult ToResult(CleanupResult result)
    {
        ArgumentNullException.ThrowIfNull(result);

        if (result.Busy)
        {
            return Results.Problem(
                statusCode: StatusCodes.Status409Conflict,
                title: "Já há uma limpeza da TV em andamento.",
                type: ProblemDetailsExtensions.TypeBase + BusyType);
        }

        var outcome = result.Outcome!;
        if (!outcome.IsDelivered)
        {
            return TvProblems.Fail(outcome);
        }

        // O comando deu certo mas o relatório não veio: não há número honesto para mostrar, então a limpeza não é dada como contada.
        if (result.Report is not { } report)
        {
            return TvProblems.Fail(TvSendOutcome.Failed(TvSendStatus.CommandFailed, ReportMissingCode, latency: outcome.Latency));
        }

        return TypedResults.Ok(new TvCleanupOk(
            true,
            (int)outcome.Latency.TotalMilliseconds,
            report.ClosedApps,
            report.FreedMb,
            report.MemoryBeforeMb,
            report.MemoryAfterMb,
            report.FailedSteps));
    }
}
