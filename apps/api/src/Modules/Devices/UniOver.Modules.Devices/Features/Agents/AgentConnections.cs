using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Presence;
using UniOver.Modules.Devices.Ports;

namespace UniOver.Modules.Devices.Features.Agents;

/// <summary>
/// As sessões vivas, uma por agente. Registrar a sessão, mexer na presença e avisar o SSE acontecem juntos sob o
/// mesmo lock: sem isso uma sessão antiga que termina logo depois de ser substituída marcaria o agente como
/// desconectado (e o SSE emitiria uma queda falsa) mesmo com a sessão nova de pé. O aviso ao SSE é só uma escrita
/// em fila (não bloqueia), então cabe dentro do lock e mantém a ordem dos eventos.
/// <para>
/// Graça de presença: a conexão do agente cai por motivos que não são dele (troca de instância no deploy, manutenção do
/// Render, rede) e volta em segundos. Quando a sessão sai, o agente continua contando como conectado por
/// <see cref="DevicesTransportOptions.PresenceGraceSeconds"/>; só se não voltar nesse prazo é que a queda é gravada e
/// anunciada. O prazo não pode superar a espera do comando, para a tela não seguir verde quando o controle já falha.
/// </para>
/// </summary>
internal sealed class AgentConnections(
    IPresenceStore presence,
    SseBroadcaster<PresenceUpdate> events,
    IEnumerable<IAgentPresenceListener>? listeners = null,
    TimeProvider? time = null,
    IOptions<DevicesTransportOptions>? options = null) : IAgentSessionCloser, IDisposable
{
    private readonly IAgentPresenceListener[] _listeners = [.. listeners ?? []];
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly TimeSpan _grace = options?.Value.PresenceGrace ?? TimeSpan.Zero;

    private readonly object _gate = new();
    private readonly Dictionary<string, IAgentSession> _sessions = new(StringComparer.Ordinal);
    private readonly Dictionary<string, PendingDrop> _drops = new(StringComparer.Ordinal);
    private readonly HashSet<string> _revokedAgents = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HashSet<TaskCompletionSource<IAgentSession?>>> _waiters = new(StringComparer.Ordinal);

    /// <summary>Torna <paramref name="session"/> a dona da conexão do agente e devolve a sessão que ela substituiu, se havia.</summary>
    public IAgentSession? Attach(IAgentSession session, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(session);
        lock (_gate)
        {
            if (_revokedAgents.Contains(session.AgentId))
            {
                throw new AgentSessionRevokedException();
            }

            _sessions.TryGetValue(session.AgentId, out var previous);
            _sessions[session.AgentId] = session;
            // Voltou dentro da graça: não há queda a anunciar.
            CancelDrop(session.AgentId);
            if (_waiters.Remove(session.AgentId, out var waiters))
            {
                foreach (var waiter in waiters)
                {
                    waiter.TrySetResult(session);
                }
            }
            Announce(presence.MarkConnected(session.AgentId, now));
            return previous;
        }
    }

    /// <summary>
    /// Tira a sessão se ainda for a atual (comparar e remover, nunca remover pelo nome): sessão substituída não
    /// mexe na presença. Devolve se mudou o estado do agente.
    /// </summary>
    public bool Detach(IAgentSession session, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(session);
        lock (_gate)
        {
            if (!_sessions.TryGetValue(session.AgentId, out var current) || !ReferenceEquals(current, session))
            {
                return false;
            }

            _sessions.Remove(session.AgentId);
            // Revogado não volta: sem graça, a queda vale na hora.
            if (_grace > TimeSpan.Zero && !_revokedAgents.Contains(session.AgentId))
            {
                ScheduleDrop(session.AgentId, now, now + _grace);
            }
            else if (presence.MarkDisconnected(session.AgentId, now) is { } info)
            {
                Announce(info);
            }

            return true;
        }
    }

    /// <summary>
    /// O agente foi visto há pouco (<paramref name="lastSeenAt"/>) por outra instância, a anterior ao deploy, e ainda não
    /// reconectou aqui: conta como conectado até <paramref name="lastSeenAt"/> mais a graça, e some se não voltar. Sem isto,
    /// a API recém-subida diria "fora do ar" para todos até cada agente reconectar. Não anuncia a quem já está ouvindo
    /// quando nada mudou, e não faz nada se há sessão aqui ou a graça já passou.
    /// </summary>
    public void ExpectReturn(string agentId, DateTimeOffset lastSeenAt, string? agentVersion)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(agentId);
        if (_grace <= TimeSpan.Zero)
        {
            return;
        }

        var expiresAt = lastSeenAt + _grace;
        lock (_gate)
        {
            if (_revokedAgents.Contains(agentId)
                || _sessions.ContainsKey(agentId)
                || expiresAt <= _time.GetUtcNow()
                || (_drops.TryGetValue(agentId, out var pending) && pending.ExpiresAt >= expiresAt))
            {
                return;
            }

            if (presence.MarkExpectedBack(agentId, lastSeenAt, agentVersion) is { } info)
            {
                Announce(info);
            }

            ScheduleDrop(agentId, lastSeenAt, expiresAt);
        }
    }

    /// <summary>O agente que já tinha sumido antes da API subir: guarda o último sinal, sem sessão nem anúncio.</summary>
    public void NoteLastSeen(string agentId, DateTimeOffset lastSeenAt, string? agentVersion)
    {
        lock (_gate)
        {
            if (!_sessions.ContainsKey(agentId) && !_drops.ContainsKey(agentId))
            {
                presence.NoteLastSeen(agentId, lastSeenAt, agentVersion);
            }
        }
    }

    /// <summary>Se o agente está sem sessão mas ainda dentro da graça (a tela o mostra conectado).</summary>
    public bool IsInGrace(string agentId)
    {
        lock (_gate)
        {
            return _drops.ContainsKey(agentId);
        }
    }

    public bool TryGet(string agentId, out IAgentSession session)
    {
        lock (_gate)
        {
            if (_revokedAgents.Contains(agentId))
            {
                session = null!;
                return false;
            }

            return _sessions.TryGetValue(agentId, out session!);
        }
    }

    /// <summary>Espera uma conexão nova por pouco tempo, para absorver a reconexão normal do agente sem enfileirar comandos.</summary>
    public async Task<IAgentSession?> WaitForSessionAsync(
        string agentId, TimeSpan timeout, TimeProvider time, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(agentId);
        ArgumentNullException.ThrowIfNull(time);

        var waiter = new TaskCompletionSource<IAgentSession?>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_gate)
        {
            if (_revokedAgents.Contains(agentId))
            {
                return null;
            }

            if (_sessions.TryGetValue(agentId, out var current))
            {
                return current;
            }

            if (!_waiters.TryGetValue(agentId, out var waiters))
            {
                waiters = new HashSet<TaskCompletionSource<IAgentSession?>>();
                _waiters.Add(agentId, waiters);
            }

            waiters.Add(waiter);
        }

        try
        {
            return await waiter.Task.WaitAsync(timeout, time, cancellationToken);
        }
        catch (TimeoutException)
        {
            return null;
        }
        finally
        {
            lock (_gate)
            {
                if (_waiters.TryGetValue(agentId, out var waiters))
                {
                    waiters.Remove(waiter);
                    if (waiters.Count == 0)
                    {
                        _waiters.Remove(agentId);
                    }
                }
            }
        }
    }

    /// <summary>Informa se a sessão atual anunciou a capacidade; versões antigas não recebem tipos novos.</summary>
    public bool Supports(IAgentSession session, string capability)
    {
        ArgumentNullException.ThrowIfNull(session);
        ArgumentException.ThrowIfNullOrWhiteSpace(capability);
        lock (_gate)
        {
            return !_revokedAgents.Contains(session.AgentId)
                && _sessions.TryGetValue(session.AgentId, out var current)
                && ReferenceEquals(current, session)
                && presence.Get(session.AgentId)?.Capabilities.Contains(capability, StringComparer.Ordinal) == true;
        }
    }

    /// <summary>Fecha a sessão atual sem esperar a outbox; chamadas repetidas são seguras.</summary>
    public async Task CloseAsync(string agentId, AgentCloseReason reason, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(agentId);
        IAgentSession? session;
        lock (_gate)
        {
            _sessions.TryGetValue(agentId, out session);
            if (reason == AgentCloseReason.Revoked)
            {
                _revokedAgents.Add(agentId);
                if (_waiters.Remove(agentId, out var waiters))
                {
                    foreach (var waiter in waiters)
                    {
                        waiter.TrySetResult(null);
                    }
                }

                if (session is null && _drops.TryGetValue(agentId, out var pending))
                {
                    // Caiu há pouco e foi revogado na graça: a queda vale agora.
                    ExpireDrop(agentId, pending);
                }
            }
        }

        if (session is not null)
        {
            try
            {
                await session.CloseAsync(reason, cancellationToken);
            }
            catch when (reason == AgentCloseReason.Revoked)
            {
                // A revogação já foi gravada: falha ao fechar o socket não pode deixar presença verde.
                Detach(session, _time.GetUtcNow());
                try
                {
                    await session.DisposeAsync();
                }
#pragma warning disable CA1031 // A revogação já foi gravada e a sessão saiu do registro, mesmo se o socket não puder fechar.
                catch (Exception)
#pragma warning restore CA1031
                {
                }
            }
        }
    }

    public bool IsCurrent(IAgentSession session)
    {
        lock (_gate)
        {
            return !_revokedAgents.Contains(session.AgentId)
                && _sessions.TryGetValue(session.AgentId, out var current)
                && ReferenceEquals(current, session);
        }
    }

    /// <summary>Registra versão e capacidades do <c>agent.hello.v1</c>; ignora sessão que já não é a atual.</summary>
    public void RecordHello(
        IAgentSession session,
        string agentVersion,
        IReadOnlyList<string> capabilities,
        DateTimeOffset now,
        AgentHostInfo? host = null,
        AgentUpdateInfo? update = null)
    {
        lock (_gate)
        {
            if (_sessions.TryGetValue(session.AgentId, out var current) && ReferenceEquals(current, session))
            {
                var before = presence.Get(session.AgentId);
                if (presence.RecordHello(session.AgentId, agentVersion, capabilities, now, host, update) is { } info
                    && !SamePublicState(before, info))
                {
                    Announce(info);
                }
            }
        }
    }

    /// <summary>
    /// O agente repete o <c>hello</c> de tempos em tempos (para valer depois de uma API que o recusou): sem mudança do que
    /// os ouvintes enxergam (conexão, versão e capacidades) ninguém é avisado; o resumo persistido é atualizado pelo
    /// hub, fora deste lock.
    /// </summary>
    private static bool SamePublicState(AgentPresenceInfo? before, AgentPresenceInfo after) =>
        before is not null
        && before.Connected == after.Connected
        && string.Equals(before.AgentVersion, after.AgentVersion, StringComparison.Ordinal)
        && before.Capabilities.SequenceEqual(after.Capabilities, StringComparer.Ordinal);

    /// <summary>Registra o estado da auto-atualização; ignora sessão que já não é a atual.</summary>
    public void RecordUpdate(IAgentSession session, AgentUpdateInfo update, DateTimeOffset now)
    {
        lock (_gate)
        {
            if (_sessions.TryGetValue(session.AgentId, out var current) && ReferenceEquals(current, session))
            {
                presence.RecordUpdate(session.AgentId, update, now);
            }
        }
    }

    public void Touch(IAgentSession session, DateTimeOffset now)
    {
        lock (_gate)
        {
            if (_sessions.TryGetValue(session.AgentId, out var current) && ReferenceEquals(current, session))
            {
                presence.Touch(session.AgentId, now);
            }
        }
    }

    private void Announce(AgentPresenceInfo info)
    {
        events.Publish(new SseMessage<PresenceUpdate>(PresenceUpdate.ChangeEvent, new PresenceUpdate([info])));

        // Em processo e sob o lock (mantém a ordem): quem escuta só pode enfileirar, nunca esperar. Falha de um
        // ouvinte não pode atrapalhar a conexão do agente nem os outros ouvintes.
        foreach (var listener in _listeners)
        {
            try
            {
                listener.OnPresenceChanged(info);
            }
#pragma warning disable CA1031 // Um ouvinte com defeito não derruba a presença.
            catch (Exception)
#pragma warning restore CA1031
            {
            }
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (var pending in _drops.Values)
            {
                pending.Timer?.Dispose();
            }

            _drops.Clear();
        }
    }

    /// <summary>Quem chama segura o lock. Substitui a espera anterior do agente, se havia.</summary>
    private void ScheduleDrop(string agentId, DateTimeOffset disconnectedAt, DateTimeOffset expiresAt)
    {
        CancelDrop(agentId);
        var pending = new PendingDrop(disconnectedAt, expiresAt);
        _drops[agentId] = pending;
        var due = expiresAt - _time.GetUtcNow();
        pending.Timer = _time.CreateTimer(
            _ => ExpireDrop(agentId, pending), null, due > TimeSpan.Zero ? due : TimeSpan.Zero, Timeout.InfiniteTimeSpan);
    }

    /// <summary>Quem chama segura o lock.</summary>
    private void CancelDrop(string agentId)
    {
        if (_drops.Remove(agentId, out var pending))
        {
            pending.Timer?.Dispose();
        }
    }

    /// <summary>A graça acabou sem o agente voltar: agora a queda vale, com o instante em que a conexão caiu de fato.</summary>
    private void ExpireDrop(string agentId, PendingDrop pending)
    {
        lock (_gate)
        {
            // Voltou (ou a espera foi trocada por outra) enquanto o temporizador disparava.
            if (!_drops.TryGetValue(agentId, out var current) || !ReferenceEquals(current, pending))
            {
                return;
            }

            CancelDrop(agentId);
            if (_sessions.ContainsKey(agentId))
            {
                return;
            }

            if (presence.MarkDisconnected(agentId, pending.DisconnectedAt) is { } info)
            {
                Announce(info);
            }
        }
    }

    private sealed class PendingDrop(DateTimeOffset disconnectedAt, DateTimeOffset expiresAt)
    {
        public DateTimeOffset DisconnectedAt { get; } = disconnectedAt;

        public DateTimeOffset ExpiresAt { get; } = expiresAt;

        public ITimer? Timer { get; set; }
    }
}

internal sealed class AgentSessionRevokedException : Exception
{
}
