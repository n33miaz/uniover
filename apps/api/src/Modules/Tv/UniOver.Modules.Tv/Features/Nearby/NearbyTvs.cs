using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Features.Config;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Nearby;

/// <summary>Uma TV compatível que o computador achou na rede dele; o <c>Id</c> é opaco (nunca endereço nem MAC).</summary>
internal sealed record NearbyTv(string Id, string Kind, string? Name, bool Controlled);

/// <summary>
/// <c>Status</c>: <c>ok</c> (a lista veio, talvez vazia), <c>offline</c> (o computador não está conectado),
/// <c>unsupported</c> (o agente dele é antigo e não procura), <c>busy</c> (já há uma procura em andamento) ou
/// <c>failed</c> (não respondeu a tempo ou não conseguiu).
/// </summary>
internal sealed record NearbyTvsResponse(string Status, IReadOnlyList<NearbyTv> Items);

/// <summary>
/// Ao adicionar uma TV, o administrador vê primeiro as TVs que o computador escolhido achou na rede local dele. É só
/// leitura (o agente lê a identificação das TVs) e só do administrador: a lista é do computador dele e nunca mistura TVs
/// de outras contas.
/// </summary>
internal sealed class NearbyTvsHandler(
    ITvDiscoveryReports reports, ITvCommandSender sender, IAgentPresenceReader presence, ITvCommandAudit audit, TimeProvider time)
{
    /// <summary>A varredura do /24 leva até uns 8 s por placa de rede; com folga para o agente responder.</summary>
    public static readonly TimeSpan SearchTimeout = TimeSpan.FromSeconds(30);

    /// <summary>Folga para a lista chegar depois do resultado do comando (o agente manda a lista antes).</summary>
    public static readonly TimeSpan ListGrace = TimeSpan.FromSeconds(2);

    public async Task<NearbyTvsResponse> SearchAsync(TvCommandOrigin origin, string agentSlug, CancellationToken cancellationToken)
    {
        var info = presence.Get(agentSlug);
        if (info is null || !info.Connected)
        {
            return new NearbyTvsResponse("offline", []);
        }

        if (!info.Capabilities.Contains(TvCapabilities.DiscoveryV1, StringComparer.Ordinal))
        {
            return new NearbyTvsResponse("unsupported", []);
        }

        using var ticket = reports.TryBegin(agentSlug);
        if (ticket is null)
        {
            return new NearbyTvsResponse("busy", []);
        }

        var outcome = await sender.RequestAsync(agentSlug, TvMessages.Discover(ticket.RequestId), SearchTimeout, cancellationToken);
        var list = outcome.IsDelivered ? await ticket.WaitAsync(ListGrace, cancellationToken) : null;
        await RecordAsync(origin, agentSlug, outcome, list is not null, cancellationToken);
        return list is null
            ? new NearbyTvsResponse("failed", [])
            : new NearbyTvsResponse("ok", [.. list.Select(tv => new NearbyTv(tv.Id, tv.Kind, tv.Name, tv.Controlled))]);
    }

    private async Task RecordAsync(TvCommandOrigin origin, string agentSlug, TvSendOutcome outcome, bool listed, CancellationToken cancellationToken)
    {
        var ok = outcome.IsDelivered && listed;
        await audit.RecordAsync(
            CommandAuditEntry.Create(
                origin.UserId, agentSlug, TvCommandNames.Discover, null, ok,
                ok ? null : outcome.ErrorCode ?? outcome.Status.ToString(), (int)outcome.Latency.TotalMilliseconds,
                origin.Client, time.GetUtcNow(), Guid.Empty),
            cancellationToken);
    }
}

internal static class NearbyTvsEndpoint
{
    public static void MapNearbyTvs(this IEndpointRouteBuilder group) =>
        group.MapGet("/tvs/nearby", SearchAsync).RequireAuthorization(UniOverAuth.OwnerPolicy)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<NearbyTvsResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> SearchAsync(
        string? agent, ICurrentUser current, HttpContext http, NearbyTvsHandler handler, CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        if (!BindAgentValidator.IsPlausibleSlug(agent))
        {
            return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: BindAgentValidator.AgentRefused);
        }

        return TypedResults.Ok(await handler.SearchAsync(origin, agent!, cancellationToken));
    }
}
