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

/// <summary>A reserva de um sinal: guarda o instante anterior para devolvê-lo se a entrega falhar.</summary>
internal readonly record struct PresenceTicket(string AgentSlug, long Now, long? Previous);

/// <summary>
/// Deixa passar no máximo um sinal de presença por agente a cada <see cref="MinInterval"/>, não importa quantas abas ou
/// pessoas o mandem: o agente só precisa saber que alguém está na tela, e uma rajada só encheria o canal dele. O sinal só
/// conta como "passou" se foi **entregue**: <see cref="Undo"/> devolve a reserva quando a entrega falha, para o sinal
/// seguinte (daqui a pouco) não ser descartado por um que nunca chegou ao agente.
/// </summary>
internal sealed class PresenceThrottle(TimeProvider time)
{
    public static readonly TimeSpan MinInterval = TimeSpan.FromSeconds(10);

    private readonly ConcurrentDictionary<string, long> last = new(StringComparer.Ordinal);

    public PresenceTicket? TryPass(string agentSlug)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(agentSlug);

        var now = time.GetTimestamp();
        while (true)
        {
            if (!last.TryGetValue(agentSlug, out var previous))
            {
                if (last.TryAdd(agentSlug, now))
                {
                    return new PresenceTicket(agentSlug, now, null);
                }

                continue;
            }

            if (time.GetElapsedTime(previous, now) < MinInterval)
            {
                return null;
            }

            if (last.TryUpdate(agentSlug, now, previous))
            {
                return new PresenceTicket(agentSlug, now, previous);
            }
        }
    }

    /// <summary>Devolve a reserva (só se ninguém mais passou nesse meio tempo).</summary>
    public void Undo(PresenceTicket ticket)
    {
        if (ticket.Previous is { } previous)
        {
            last.TryUpdate(ticket.AgentSlug, previous, ticket.Now);
        }
        else
        {
            last.TryRemove(new KeyValuePair<string, long>(ticket.AgentSlug, ticket.Now));
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
            || throttle.TryPass(agentId) is not { } ticket)
        {
            return;
        }

        // Falha de entrega não é problema de quem só avisa que está olhando, mas o sinal que não chegou ao agente não
        // pode ocupar o intervalo: a reserva volta e o próximo tenta de novo.
        var outcome = await runner.RunAsync(
            origin,
            CommandName,
            null,
            TvMessages.Presence(),
            waitForReply: false,
            cancellationToken: cancellationToken,
            auditCommand: false);
        if (!outcome.IsDelivered)
        {
            throttle.Undo(ticket);
        }
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
