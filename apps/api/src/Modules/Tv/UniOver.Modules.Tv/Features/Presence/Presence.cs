using System.Collections.Concurrent;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;

namespace UniOver.Modules.Tv.Features.Presence;

/// <summary>
/// Deixa passar no máximo um sinal de presença por agente a cada <see cref="MinInterval"/>, não importa quantas abas ou
/// pessoas o mandem: o agente só precisa saber que alguém está na tela, e uma rajada só encheria o canal dele.
/// </summary>
internal sealed class PresenceThrottle(TimeProvider time)
{
    public static readonly TimeSpan MinInterval = TimeSpan.FromSeconds(10);

    private readonly ConcurrentDictionary<string, long> last = new(StringComparer.Ordinal);

    public bool TryPass(string agentSlug)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(agentSlug);

        var now = time.GetTimestamp();
        while (true)
        {
            if (!last.TryGetValue(agentSlug, out var previous))
            {
                if (last.TryAdd(agentSlug, now))
                {
                    return true;
                }

                continue;
            }

            if (time.GetElapsedTime(previous, now) < MinInterval)
            {
                return false;
            }

            if (last.TryUpdate(agentSlug, now, previous))
            {
                return true;
            }
        }
    }
}

/// <summary>
/// A tela da TV, enquanto está visível, avisa que há alguém diante dela. É o único sinal que deixa o agente abrir uma
/// conexão ADB nova por conta própria: o tipo do comando não prova ninguém (o atalho do iPhone e o desligamento agendado
/// mandam teclas e abrem apps sem pessoa na tela). Por isso este é um aviso à parte, sem corpo, sem resposta e sem
/// auditoria, que só segue a agentes que declaram <c>tv.presence.v1</c> e no máximo um a cada 10 s por agente.
/// </summary>
internal sealed class PresenceHandler(TvCommandRunner runner, IAgentPresenceReader presence, PresenceThrottle throttle)
{
    // Só para o executor: o sinal não é comando para a TV e nunca vai à trilha (por isso não está em `TvCommandNames`).
    private const string CommandName = "tv.presence";

    public async Task HandleAsync(TvCommandOrigin origin, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(origin);

        var target = await runner.ResolveTargetAsync(cancellationToken);
        var agentId = target.AgentSlug;
        if (string.IsNullOrWhiteSpace(agentId)
            || presence.Get(agentId) is not { } info
            || !info.Capabilities.Contains(TvCapabilities.PresenceV1, StringComparer.Ordinal)
            || !throttle.TryPass(agentId))
        {
            return;
        }

        // Falha de entrega não é problema de quem só avisa que está olhando: o próximo sinal tenta de novo.
        _ = await runner.RunAsync(
            origin,
            CommandName,
            null,
            TvMessages.Presence(),
            waitForReply: false,
            cancellationToken: cancellationToken,
            auditCommand: false);
    }
}

internal static class PresenceEndpoint
{
    public static void MapPresence(this IEndpointRouteBuilder group) =>
        group.MapPost("/presence", HandleAsync).RequireAuthorization(TvAuth.Control)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces(StatusCodes.Status202Accepted)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current, HttpContext http, PresenceHandler handler, CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        await handler.HandleAsync(origin, cancellationToken);
        return TypedResults.Accepted((string?)null);
    }
}
