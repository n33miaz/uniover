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

    /// <summary>
    /// Passa a vigiar o agente da TV. Só o primeiro registro grava o elo visto como linha de base; quem já é vigiado mantém o
    /// último elo publicado, para que uma mudança que uma leitura enxergou (e não publicou) ainda saia na próxima passada.
    /// </summary>
    public void Track(Guid tvId, string? agentSlug, TvState observed)
    {
        if (string.IsNullOrWhiteSpace(agentSlug))
        {
            return;
        }

        lock (_gate)
        {
            if (_watched.TryGetValue(agentSlug, out var current) && current.TvId == tvId)
            {
                return;
            }

            Note(tvId, agentSlug, observed);
        }
    }

    /// <summary>
    /// Publica o estado de um relato ou de uma leitura e anota o elo na mesma região crítica da vigia: a ordem de publicação
    /// e a linha de base concordam, e uma passada que capturou o elo antes deste relato não o sobrescreve depois.
    /// </summary>
    public void Publish(Guid tvId, string? agentSlug, TvState view)
    {
        lock (_gate)
        {
            stream.PublishState(tvId, view);
            if (!string.IsNullOrWhiteSpace(agentSlug))
            {
                Note(tvId, agentSlug, view);
            }
        }
    }

    /// <summary>Para de vigiar o agente que deixou a TV (religada a outro): o elo dele não vai mais ao fluxo dela.</summary>
    public void Release(Guid tvId, string? agentSlug)
    {
        if (string.IsNullOrWhiteSpace(agentSlug))
        {
            return;
        }

        lock (_gate)
        {
            if (_watched.TryGetValue(agentSlug, out var watched) && watched.TvId == tvId)
            {
                _watched.Remove(agentSlug);
            }
        }
    }

    // Chamar com _gate. Uma TV tem um agente só: qualquer outro que a vigiava saiu dela.
    private void Note(Guid tvId, string agentSlug, TvState view)
    {
        foreach (var other in _watched.Where(w => w.Value.TvId == tvId && w.Key != agentSlug).Select(w => w.Key).ToArray())
        {
            _watched.Remove(other);
        }

        _watched[agentSlug] = new Watched(tvId, view.Link?.State);
    }

    /// <summary>Uma passada: recalcula o elo de cada TV vigiada e publica as que mudaram.</summary>
    public void Check()
    {
        string[] agents;
        lock (_gate)
        {
            agents = [.. _watched.Keys];
        }

        foreach (var agentId in agents)
        {
            // Visão, comparação, publicação e anotação juntas sob a trava: um relato que chegar no meio espera e vence depois.
            lock (_gate)
            {
                if (!_watched.TryGetValue(agentId, out var watched))
                {
                    continue;
                }

                var view = TvState.From(
                    state.Last(agentId), presence.IsOnline(agentId), offlineSince: presence.OfflineSince(agentId),
                    reportFresh: presence.HasRecentReport(agentId, options.Value.LinkStale));
                if (string.Equals(view.Link?.State, watched.LinkState, StringComparison.Ordinal))
                {
                    continue;
                }

                _watched[agentId] = watched with { LinkState = view.Link?.State };
                stream.PublishState(watched.TvId, view);
            }
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
