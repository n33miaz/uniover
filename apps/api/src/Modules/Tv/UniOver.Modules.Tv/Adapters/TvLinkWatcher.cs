using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Tvs;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Publica as mudanças do elo que vêm só do tempo: o agente segue conectado mas calado além da janela de relato (o elo vira
/// <c>pc_offline</c>), ou volta a falar sem trazer estado de TV (o elo volta). Nenhum evento acompanha essas duas
/// transições, então uma checagem leve, só em memória, recalcula o elo das TVs já vistas e avisa o fluxo da TV afetada
/// quando ele difere do último publicado.
/// </summary>
internal sealed partial class TvLinkWatcher(
    ITvStateStore state,
    ITvAgentPresence presence,
    ITvStreamPublisher stream,
    IOptions<TvModuleOptions> options,
    ILogger<TvLinkWatcher> logger,
    IServiceScopeFactory? scopes = null)
    : BackgroundService
{
    internal static readonly TimeSpan Interval = TimeSpan.FromSeconds(5);

    private readonly object _gate = new();
    private readonly Dictionary<string, Watched> _watched = new(StringComparer.Ordinal);
    private readonly Dictionary<Guid, Binding> _bindings = [];

    private sealed record Watched(Guid TvId, string? LinkState);
    private sealed record Binding(string? AgentSlug, bool NeedsRefresh = false);

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
            if (!IsCurrentAgent(tvId, agentSlug) || IsWatching(tvId, agentSlug))
            {
                return;
            }

            Note(tvId, agentSlug, observed);
        }
    }

    /// <summary>
    /// Publica o estado de um relato e anota o elo na mesma região crítica da vigia: a ordem de publicação
    /// e a linha de base concordam, e uma passada que capturou o elo antes deste relato não o sobrescreve depois.
    /// </summary>
    public void Publish(Guid tvId, string? agentSlug, TvState view)
    {
        lock (_gate)
        {
            if (!IsCurrentAgent(tvId, agentSlug))
            {
                return;
            }

            stream.PublishState(tvId, view);
            if (!string.IsNullOrWhiteSpace(agentSlug))
            {
                Note(tvId, agentSlug, view);
            }
        }
    }

    /// <summary>Aplica ao fluxo a presença observada por uma leitura, se a TV ainda estiver com o mesmo agente.</summary>
    public void ObserveRead(Guid tvId, string agentSlug, TvState view, bool online)
    {
        lock (_gate)
        {
            if (!IsCurrentAgent(tvId, agentSlug))
            {
                return;
            }

            // Se a leitura descobriu uma mudança, avisa antes que um comando a encontre já anotada.
            var changed = state.NoteOnline(agentSlug, online);
            if (changed)
            {
                stream.PublishState(tvId, view);
            }

            if (!string.IsNullOrWhiteSpace(agentSlug) && (changed || !IsWatching(tvId, agentSlug)))
            {
                Note(tvId, agentSlug, view);
            }
        }
    }

    /// <summary>Registra a troca gravada, antes mesmo de haver uma observação do computador novo.</summary>
    public void Rebind(Guid tvId, string agentSlug)
    {
        lock (_gate)
        {
            _bindings[tvId] = new Binding(agentSlug);
            RemoveOtherAgents(tvId, agentSlug);
        }
    }

    /// <summary>
    /// Relê o vínculo de uma troca já gravada e o aplica em memória. Se a releitura falhar, a vigia esquece o vínculo que
    /// guardava da TV (recusa observações de qualquer computador dela) e o relê do banco na próxima passada; a falha não sobe
    /// para quem chamou, porque a troca já está confirmada.
    /// </summary>
    public async Task SynchronizeBindingAsync(
        TvDbContext db, ConfiguredTv saved, ITvAgentResolver resolver, Action<ConfiguredTv> apply)
    {
        var tvId = saved.Id;
        Binding? before;
        lock (_gate)
        {
            before = _bindings.GetValueOrDefault(tvId);
        }

        // A troca já foi confirmada mesmo que a requisição seja cancelada.
        if (await TryApplyCurrentBindingAsync(db, tvId, resolver, apply, CancellationToken.None))
        {
            return;
        }

        lock (_gate)
        {
            // Outra releitura que já aplicou o vínculo sob o bloqueio viu este commit ou um mais recente.
            if (ReferenceEquals(before, _bindings.GetValueOrDefault(tvId)))
            {
                _bindings[tvId] = new Binding(null, NeedsRefresh: true);
                RemoveOtherAgents(tvId, null);
                if (saved.IsDefault)
                {
                    resolver.Invalidate();
                }
            }
        }
    }

    private async Task<bool> TryApplyCurrentBindingAsync(
        TvDbContext db, Guid tvId, ITvAgentResolver resolver, Action<ConfiguredTv> apply, CancellationToken cancellationToken)
    {
#pragma warning disable CA1031 // A troca já foi gravada; a vigia repete a sincronização na próxima passada.
        try
        {
            await TvRowLock.ApplyToCurrentBindingAsync(db, tvId, current =>
            {
                if (current is null)
                {
                    lock (_gate)
                    {
                        _bindings[tvId] = new Binding(null);
                        RemoveOtherAgents(tvId, null);
                    }
                }
                else
                {
                    if (current.IsDefault)
                    {
                        resolver.Set(new TvAgentBinding(current.AgentSlug, current.Name, TvAgentSource.Saved));
                    }

                    apply(current);
                }
            }, cancellationToken);
            return true;
        }
        catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
        {
            LogBindingSyncFailed(tvId, ex.GetType().Name);
            return false;
        }
#pragma warning restore CA1031
    }

    // Chamar com _gate. A troca gravada prevalece sobre observações que ainda carregam o vínculo anterior.
    private bool IsCurrentAgent(Guid tvId, string? agentSlug) =>
        !_bindings.TryGetValue(tvId, out var current)
        || (current.AgentSlug is not null && string.Equals(current.AgentSlug, agentSlug, StringComparison.Ordinal));

    private bool IsWatching(Guid tvId, string agentSlug) =>
        _watched.TryGetValue(agentSlug, out var current) && current.TvId == tvId;

    private void Note(Guid tvId, string agentSlug, TvState view)
    {
        RemoveOtherAgents(tvId, agentSlug);
        _watched[agentSlug] = new Watched(tvId, view.Link?.State);
    }

    private void RemoveOtherAgents(Guid tvId, string? agentSlug)
    {
        foreach (var other in _watched.Where(w => w.Value.TvId == tvId && w.Key != agentSlug).Select(w => w.Key).ToArray())
        {
            _watched.Remove(other);
        }
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
            CheckAgent(agentId);
        }
    }

    private void CheckAgent(string agentId)
    {
        Guid? tvId = null;
#pragma warning disable CA1031 // A falha ao vigiar um agente não interrompe os demais.
        try
        {
            // Visão, comparação, publicação e anotação juntas sob a trava: um relato que chegar no meio espera e vence depois.
            lock (_gate)
            {
                if (!_watched.TryGetValue(agentId, out var watched))
                {
                    return;
                }

                tvId = watched.TvId;
                var view = ReadState(agentId);
                if (string.Equals(view.Link?.State, watched.LinkState, StringComparison.Ordinal))
                {
                    return;
                }

                stream.PublishState(watched.TvId, view);
                _watched[agentId] = watched with { LinkState = view.Link?.State };
            }
        }
        catch (Exception ex)
        {
            LogAgentCheckFailed(agentId, tvId ?? Guid.Empty, ex.GetType().Name);
        }
#pragma warning restore CA1031
    }

    private TvState ReadState(string agentSlug) =>
        TvState.From(state.Last(agentSlug), presence.IsOnline(agentSlug), offlineSince: presence.OfflineSince(agentSlug),
            reportFresh: presence.HasRecentReport(agentSlug, options.Value.LinkStale));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                await RunPassAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Parada normal do host.
        }
    }

    internal async Task RunPassAsync(CancellationToken cancellationToken)
    {
#pragma warning disable CA1031 // Uma passada com defeito não pode parar a vigia das próximas.
        try
        {
            if (scopes is not null)
            {
                await RefreshBindingsAsync(scopes, cancellationToken);
            }

            Check();
        }
        catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
        {
            LogPassFailed(ex.GetType().Name);
        }
#pragma warning restore CA1031
    }

    private async Task RefreshBindingsAsync(IServiceScopeFactory scopeFactory, CancellationToken cancellationToken)
    {
        Guid[] tvIds;
        lock (_gate)
        {
            tvIds = [.. _bindings.Where(pair => pair.Value.NeedsRefresh).Select(pair => pair.Key)];
        }

        foreach (var tvId in tvIds)
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<TvDbContext>();
            var resolver = scope.ServiceProvider.GetRequiredService<ITvAgentResolver>();
            await TryApplyCurrentBindingAsync(db, tvId, resolver, current =>
            {
                lock (_gate)
                {
                    if (!_bindings[tvId].NeedsRefresh)
                    {
                        return;
                    }

                    var slug = current.AgentSlug;
                    if (current.IsDefault)
                    {
                        stream.AdoptUnidentifiedStream(tvId);
                    }

                    var view = ReadState(slug);
                    Rebind(tvId, slug);
                    Publish(tvId, slug, view);
                }
            }, cancellationToken);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Falha ao sincronizar o vínculo gravado da TV {TvId} ({ErrorType}).")]
    private partial void LogBindingSyncFailed(Guid tvId, string errorType);

    // Só o tipo do erro: a mensagem da exceção pode citar infraestrutura ou vazar segredos.
    [LoggerMessage(Level = LogLevel.Error, Message = "Falha ao verificar elo do agente {AgentId} da TV {TvId} ({ErrorType}).")]
    internal partial void LogAgentCheckFailed(string agentId, Guid tvId, string errorType);

    [LoggerMessage(Level = LogLevel.Error, Message = "Falha na passada da vigia de elo das TVs ({ErrorType}).")]
    internal partial void LogPassFailed(string errorType);
}
