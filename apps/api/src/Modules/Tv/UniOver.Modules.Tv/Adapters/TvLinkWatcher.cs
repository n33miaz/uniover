using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Publica as mudanças do elo que vêm só do tempo: o agente segue conectado mas calado além da janela de relato (o elo vira
/// <c>pc_offline</c>), ou volta a falar sem trazer estado de TV (o elo volta). Nenhum evento acompanha essas duas
/// transições, então uma checagem leve, só em memória, recalcula o elo das TVs já vistas e avisa o fluxo da TV afetada
/// quando ele difere do último publicado.
/// </summary>
internal sealed class TvLinkWatcher(
    ITvStateStore state, ITvAgentPresence presence, ITvStreamPublisher stream, IOptions<TvModuleOptions> options)
    : BackgroundService
{
    internal static readonly TimeSpan Interval = TimeSpan.FromSeconds(5);

    private readonly object _gate = new();
    private readonly Dictionary<string, Watched> _watched = new(StringComparer.Ordinal);

    private sealed record Watched(Guid TvId, string? LinkState);

    /// <summary>Passa a vigiar o agente da TV e guarda o elo que acabou de ser publicado (ou lido) para ela.</summary>
    public void Track(Guid tvId, string? agentSlug, TvState published)
    {
        if (string.IsNullOrWhiteSpace(agentSlug))
        {
            return;
        }

        lock (_gate)
        {
            _watched[agentSlug] = new Watched(tvId, published.Link?.State);
        }
    }

    /// <summary>Uma passada: recalcula o elo de cada TV vigiada e publica as que mudaram.</summary>
    public void Check()
    {
        KeyValuePair<string, Watched>[] snapshot;
        lock (_gate)
        {
            snapshot = [.. _watched];
        }

        foreach (var (agentId, watched) in snapshot)
        {
            var online = presence.IsOnline(agentId);
            var view = TvState.From(
                state.Last(agentId), online, offlineSince: presence.OfflineSince(agentId),
                reportFresh: presence.HasRecentReport(agentId, options.Value.LinkStale));
            if (string.Equals(view.Link?.State, watched.LinkState, StringComparison.Ordinal))
            {
                continue;
            }

            lock (_gate)
            {
                // Outro caminho (relato, presença) pode ter publicado e anotado o elo entre a cópia e agora.
                if (!_watched.TryGetValue(agentId, out var current)
                    || !string.Equals(current.LinkState, watched.LinkState, StringComparison.Ordinal))
                {
                    continue;
                }

                _watched[agentId] = current with { LinkState = view.Link?.State };
            }

            stream.PublishState(watched.TvId, view);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
#pragma warning disable CA1031 // Uma passada com defeito não pode parar a vigia das próximas.
                try
                {
                    Check();
                }
                catch (Exception)
                {
                }
#pragma warning restore CA1031
            }
        }
        catch (OperationCanceledException)
        {
            // Parada normal do host.
        }
    }
}
