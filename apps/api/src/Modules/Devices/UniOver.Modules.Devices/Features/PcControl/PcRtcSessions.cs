namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>Uma sessão do canal direto, como a API a conhece: de quem é, de qual PC, e quando a negociação começou.</summary>
/// <param name="SessionFamily">A sessão (família do refresh) que abriu o canal: ela acabando, o canal fecha junto.</param>
/// <param name="RevokePending">A revogação não alcançou o agente (ele estava fora): refeita assim que ele volta.</param>
/// <param name="Scopes">O que o canal pode levar: o que a pessoa podia no instante da oferta (o PC e/ou a TV).</param>
/// <param name="TvId">A TV do escopo <c>tv</c> (a trilha e a revogação da TV a usam); nula sem o escopo.</param>
internal sealed record PcRtcSession(
    Guid Id,
    Guid UserId,
    Guid AgentId,
    string AgentSlug,
    DateTimeOffset OpenedAt,
    Guid? SessionFamily = null,
    bool RevokePending = false,
    PcRtcScopes Scopes = PcRtcScopes.Pc,
    Guid? TvId = null,
    Guid? ParentSessionId = null,
    DateTimeOffset? NegotiatedUntil = null);

/// <summary>O que o registro fez com a sessão que o agente disse ter aberto.</summary>
internal enum PcRtcRestoreOutcome
{
    /// <summary>A API não a tinha: foi reconstruída e agora precisa ser conferida.</summary>
    Restored,

    /// <summary>A API já a tinha, íntegra: segue como está (e precisa ser conferida de novo).</summary>
    Known,

    /// <summary>Não vale: já foi fechada, está marcada para revogação ou o registro diz que é de outra pessoa.</summary>
    Closed,

    /// <summary>Outra sessão ocupa este PC agora: o agente a troca, então a dele sai.</summary>
    Replaced,
}

internal sealed record PcRtcRestore(PcRtcRestoreOutcome Outcome, PcRtcSession? Session);

/// <summary>
/// As sessões do canal direto, em memória e da instância. Serve a três coisas: só quem abriu a sessão mexe nela (candidato e
/// fechamento de outra pessoa dão "não existe"), a janela de negociação do token vence sozinha (candidato depois dela é
/// recusado) e a trilha só grava "fechado" uma vez por sessão. Nada do SDP nem o token ficam aqui.
/// </summary>
internal sealed class PcRtcSessions(TimeProvider time)
{
    /// <summary>
    /// Vida do token (contada pelo agente a partir do recebimento da oferta) e janela em que a API ainda aceita candidatos.
    /// Curta de propósito: a negociação de um canal local leva menos de um segundo.
    /// </summary>
    public static readonly TimeSpan TokenLifetime = TimeSpan.FromSeconds(30);

    /// <summary>Uma sessão esquecida (o agente caiu sem avisar) some daqui depois disto.</summary>
    public static readonly TimeSpan MaxAge = TimeSpan.FromHours(12);

    /// <summary>
    /// O agente soma o que o canal da TV levou e avisa ao fechar; quando foi a API que mandou fechar, o aviso chega depois de a sessão
    /// já ter saído do registro. Estas ficam aqui por pouco tempo, só para ele ainda saber de quem e de qual TV a soma é.
    /// </summary>
    public static readonly TimeSpan ClosedTvMemory = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Quanto o registro lembra que uma sessão saiu dele (fechada pela pessoa, pela API ou pelo agente): o agente que reconecta e a lista
    /// como aberta não a ressuscita. Passa da vida máxima de um canal, que é até quando o agente poderia ainda segurá-la.
    /// </summary>
    public static readonly TimeSpan TombstoneMemory = PcRtcHandler.MaxLifetime + TokenLifetime;

    /// <summary>Teto das lápides (uma por canal fechado): passando dele, as mais antigas saem primeiro.</summary>
    public const int MaxTombstones = 256;

    private readonly object _gate = new();
    private readonly Dictionary<Guid, PcRtcSession> _sessions = [];
    private readonly Dictionary<Guid, DateTimeOffset> _tombstones = [];
    private readonly Dictionary<Guid, (PcRtcSession Session, DateTimeOffset Until)> _closedTv = [];
    private readonly Dictionary<Guid, (Guid UserId, string AgentSlug, DateTimeOffset OpenedAt, DateTimeOffset Until)> _closedUsage = [];

    // O total de uso já aceito de cada sessão: o app manda o TOTAL acumulado, então repetir não soma de novo, e o aceito nunca passa do
    // tempo que de fato correu desde a abertura do canal (mais a folga).
    private readonly Dictionary<Guid, int> _usage = [];

    /// <summary>Teto do total de uso de uma sessão (a vida de um canal é bem menor: isto só barra número absurdo).</summary>
    public const int MaxUsageTotalSeconds = 3_600;

    /// <summary>Folga do tempo corrido no aceite do uso (o segundo em andamento, a ida da requisição).</summary>
    public static readonly TimeSpan UsageSlack = TimeSpan.FromSeconds(5);

    /// <summary>
    /// O app conta o uso do canal à API a cada minuto e ao fechar; o fechamento (dele, do agente ou da API) tira a sessão daqui antes
    /// de a última contagem chegar. A sessão fica lembrada por este tempo só para a contagem final ainda valer (paridade).
    /// </summary>
    public static readonly TimeSpan ClosedUsageMemory = TimeSpan.FromMinutes(2);

    public PcRtcSession Open(
        Guid userId, Guid agentId, string agentSlug, Guid? sessionFamily = null, PcRtcScopes scopes = PcRtcScopes.Pc, Guid? tvId = null)
    {
        var now = time.GetUtcNow();
        lock (_gate)
        {
            return OpenLocked(userId, agentId, agentSlug, sessionFamily, scopes, tvId, now);
        }
    }

    /// <summary>
    /// Abre a sessão SE nenhum canal vivo de outra pessoa ocupa o agente (o administrador toma o de qualquer um). A verificação, a captura
    /// das sessões anteriores (<paramref name="previous"/>, as que esta oferta vai substituir) e a abertura acontecem sob o mesmo trinco:
    /// duas ofertas concorrentes nunca passam as duas, e quem substitui fecha EXATAMENTE as que estavam lá quando abriu. Nulo: ocupado.
    /// </summary>
    public PcRtcSession? TryOpen(
        Guid userId,
        bool isOwner,
        Guid agentId,
        string agentSlug,
        Guid? sessionFamily,
        PcRtcScopes scopes,
        Guid? tvId,
        out IReadOnlyList<PcRtcSession> previous)
    {
        var now = time.GetUtcNow();
        lock (_gate)
        {
            if (!isOwner && HasLiveOfAnotherLocked(agentSlug, userId, now))
            {
                previous = [];
                return null;
            }

            previous = _sessions.Values.Where(s => s.Scopes != PcRtcScopes.Screen
                && string.Equals(s.AgentSlug, agentSlug, StringComparison.Ordinal)).ToList();
            return OpenLocked(userId, agentId, agentSlug, sessionFamily, scopes, tvId, now);
        }
    }

    public PcRtcSession? TryOpenScreen(
        Guid userId, Guid agentId, string agentSlug, Guid? family, Guid parentId, out IReadOnlyList<PcRtcSession> previous)
    {
        var now = time.GetUtcNow();
        lock (_gate)
        {
            if (!HasScreenParentLocked(parentId, userId, agentId, family, now))
            {
                previous = [];
                return null;
            }

            previous = _sessions.Values.Where(s => s.Scopes == PcRtcScopes.Screen && s.AgentId == agentId).ToList();
            return OpenLocked(userId, agentId, agentSlug, family, PcRtcScopes.Screen, null, now, parentId);
        }
    }

    private bool HasScreenParentLocked(Guid parentId, Guid userId, Guid agentId, Guid? family, DateTimeOffset now) =>
        family is not null
        && _sessions.TryGetValue(parentId, out var parent)
        && parent.UserId == userId && parent.AgentId == agentId && parent.SessionFamily == family
        && parent.Scopes.HasFlag(PcRtcScopes.Pc) && !parent.RevokePending && parent.NegotiatedUntil > now;

    public bool FinishNegotiation(Guid sessionId, Guid userId, DateTimeOffset until)
    {
        lock (_gate)
        {
            if (!_sessions.TryGetValue(sessionId, out var session) || session.UserId != userId || session.RevokePending
                || session.ParentSessionId is { } parentId
                    && !HasScreenParentLocked(parentId, userId, session.AgentId, session.SessionFamily, time.GetUtcNow()))
            {
                return false;
            }

            _sessions[sessionId] = session with { NegotiatedUntil = until };
            return true;
        }
    }

    private PcRtcSession OpenLocked(
        Guid userId, Guid agentId, string agentSlug, Guid? sessionFamily, PcRtcScopes scopes, Guid? tvId, DateTimeOffset now,
        Guid? parentId = null)
    {
        var session = new PcRtcSession(Guid.CreateVersion7(), userId, agentId, agentSlug, now, sessionFamily, Scopes: scopes, TvId: tvId, ParentSessionId: parentId);
        foreach (var old in _sessions.Where(s => now - s.Value.OpenedAt > MaxAge).Select(s => s.Key).ToList())
        {
            _sessions.Remove(old);
        }

        foreach (var old in _closedTv.Where(c => c.Value.Until <= now).Select(c => c.Key).ToList())
        {
            _closedTv.Remove(old);
        }

        _sessions[session.Id] = session;
        return session;
    }

    private bool HasLiveOfAnotherLocked(string agentSlug, Guid userId, DateTimeOffset now) =>
        _sessions.Values.Any(s =>
            s.UserId != userId
            && s.Scopes != PcRtcScopes.Screen
            && string.Equals(s.AgentSlug, agentSlug, StringComparison.Ordinal)
            && now - s.OpenedAt <= PcRtcHandler.MaxLifetime + TokenLifetime);

    /// <summary>Tira a sessão do registro e, se levava a TV, a lembra por pouco tempo (a soma do agente ainda vai chegar).</summary>
    private void Forget(PcRtcSession session)
    {
        _sessions.Remove(session.Id);
        Remember(session.Id);
        if (session.Scopes != PcRtcScopes.Screen)
        {
            RememberUsage(session);
        }

        if (session.TvId is not null)
        {
            _closedTv[session.Id] = (session, time.GetUtcNow() + ClosedTvMemory);
        }
    }

    private void RememberUsage(PcRtcSession session)
    {
        var now = time.GetUtcNow();
        _closedUsage[session.Id] = (session.UserId, session.AgentSlug, session.OpenedAt, now + ClosedUsageMemory);
        PruneUsageLocked(now);
        while (_closedUsage.Count > MaxTombstones)
        {
            var oldest = _closedUsage.MinBy(c => c.Value.Until).Key;
            _closedUsage.Remove(oldest);
            _usage.Remove(oldest);
        }
    }

    /// <summary>Quem chama segura o trinco: some o que já não pode receber uso (fechada há mais do prazo, ou que saiu sem lembrança).</summary>
    private void PruneUsageLocked(DateTimeOffset now)
    {
        foreach (var old in _closedUsage.Where(c => c.Value.Until <= now).Select(c => c.Key).ToList())
        {
            _closedUsage.Remove(old);
        }

        foreach (var orphan in _usage.Keys.Where(id => !_sessions.ContainsKey(id) && !_closedUsage.ContainsKey(id)).ToList())
        {
            _usage.Remove(orphan);
        }
    }

    /// <summary>Quem chama segura o trinco: o agente e a abertura da sessão que pode receber uso desta pessoa agora, ou nada.</summary>
    private (string AgentSlug, DateTimeOffset OpenedAt)? UsageSessionLocked(Guid sessionId, Guid userId, DateTimeOffset now)
    {
        if (_sessions.TryGetValue(sessionId, out var live))
        {
            // Viva, desta pessoa e dentro da vida máxima de um canal (a esquecida pelo agente não conta).
            return live.UserId == userId && live.Scopes != PcRtcScopes.Screen && now - live.OpenedAt <= PcRtcHandler.MaxLifetime + TokenLifetime
                ? (live.AgentSlug, live.OpenedAt)
                : null;
        }

        return _closedUsage.TryGetValue(sessionId, out var closed) && closed.UserId == userId && closed.Until > now
            ? (closed.AgentSlug, closed.OpenedAt)
            : null;
    }

    /// <summary>
    /// A sessão pode receber o uso do canal desta pessoa: viva (dentro da vida máxima) ou fechada há pouco (a contagem final chega depois
    /// do fechamento). É só memória: é o que autoriza a rota do uso, sem consultar permissão nenhuma no banco (a oferta já autorizou).
    /// </summary>
    public bool AcceptsUsage(Guid sessionId, Guid userId)
    {
        lock (_gate)
        {
            return UsageSessionLocked(sessionId, userId, time.GetUtcNow()) is not null;
        }
    }

    /// <summary>
    /// Registra o TOTAL de segundos de uso que o app contou nesta sessão e devolve o agente e quanto disso é novo. O aceito da sessão
    /// nunca passa do tempo que correu desde a abertura do canal mais <see cref="UsageSlack"/> (o novo de cada envio, então, nunca passa do
    /// tempo desde o último aceite mais a folga): repetir o mesmo total soma zero, e um total inflado só vale o tempo real, por mais que
    /// se repita. Nulo: a sessão não pode receber uso desta pessoa.
    /// </summary>
    public (string AgentSlug, int Added)? RecordUsage(Guid sessionId, Guid userId, int total)
    {
        var now = time.GetUtcNow();
        lock (_gate)
        {
            PruneUsageLocked(now);
            if (UsageSessionLocked(sessionId, userId, now) is not { } target)
            {
                return null;
            }

            var accepted = _usage.GetValueOrDefault(sessionId);
            var ceiling = (int)Math.Ceiling(Math.Max(0, (now - target.OpenedAt + UsageSlack).TotalSeconds));
            var added = Math.Max(0, Math.Min(total, ceiling) - accepted);
            if (added > 0)
            {
                _usage[sessionId] = accepted + added;
            }

            return (target.AgentSlug, added);
        }
    }

    private void Remember(Guid sessionId)
    {
        var now = time.GetUtcNow();
        foreach (var old in _tombstones.Where(t => t.Value <= now).Select(t => t.Key).ToList())
        {
            _tombstones.Remove(old);
        }

        _tombstones[sessionId] = now + TombstoneMemory;
        while (_tombstones.Count > MaxTombstones)
        {
            _tombstones.Remove(_tombstones.MinBy(t => t.Value).Key);
        }
    }

    /// <summary>
    /// Reconstrói a sessão de um canal que o agente diz ter aberto (a API reiniciou e perdeu o registro, ou só a conexão caiu): mantém o id,
    /// sob o mesmo trinco das demais operações. Nada é reconstruído de uma sessão que a API já fechou (lápide), que está marcada para
    /// revogação ou que é de outra pessoa; e o agente só tem UM canal, então outra sessão viva neste PC (uma oferta em curso) vale mais que a
    /// do agente, que vai ser trocada de qualquer jeito. Quem chama confere o direito DEPOIS de a sessão estar aqui, para uma revogação no
    /// meio a encontrar.
    /// </summary>
    public PcRtcRestore Restore(PcRtcSession claimed)
    {
        ArgumentNullException.ThrowIfNull(claimed);
        var now = time.GetUtcNow();
        lock (_gate)
        {
            if (_tombstones.TryGetValue(claimed.Id, out var until) && until > now)
            {
                return new PcRtcRestore(PcRtcRestoreOutcome.Closed, null);
            }

            if (_sessions.TryGetValue(claimed.Id, out var known))
            {
                return known.UserId == claimed.UserId
                    && string.Equals(known.AgentSlug, claimed.AgentSlug, StringComparison.Ordinal)
                    && !known.RevokePending
                        ? new PcRtcRestore(PcRtcRestoreOutcome.Known, known)
                        : new PcRtcRestore(PcRtcRestoreOutcome.Closed, null);
            }

            if (_sessions.Values.Any(s => s.Scopes != PcRtcScopes.Screen
                && string.Equals(s.AgentSlug, claimed.AgentSlug, StringComparison.Ordinal)))
            {
                return new PcRtcRestore(PcRtcRestoreOutcome.Replaced, null);
            }

            _sessions[claimed.Id] = claimed;
            return new PcRtcRestore(PcRtcRestoreOutcome.Restored, claimed);
        }
    }

    /// <summary>
    /// A sessão está no registro AGORA, é desta pessoa e não está marcada para revogação? Conferido sob o trinco, imediatamente antes de a
    /// API confirmar o canal ao agente: uma revogação que chegou entre a conferência e a confirmação a tirou ou a marcou, e então não se confirma.
    /// </summary>
    public bool IsLiveAndClean(Guid sessionId, Guid userId)
    {
        lock (_gate)
        {
            return _sessions.TryGetValue(sessionId, out var session) && session.UserId == userId && !session.RevokePending;
        }
    }

    /// <summary>A sessão que já saiu do registro mas levava a TV, se o aviso do agente é dela (mesmo agente) e ainda está na memória.</summary>
    public PcRtcSession? TakeClosedTv(string agentSlug, Guid sessionId)
    {
        lock (_gate)
        {
            if (!_closedTv.TryGetValue(sessionId, out var entry) || entry.Until <= time.GetUtcNow()
                || !string.Equals(entry.Session.AgentSlug, agentSlug, StringComparison.Ordinal))
            {
                return null;
            }

            _closedTv.Remove(sessionId);
            return entry.Session;
        }
    }

    /// <summary>A sessão, se é desta pessoa; <paramref name="negotiating"/> exige também que a janela do token ainda esteja aberta.</summary>
    public PcRtcSession? Get(Guid sessionId, Guid userId, bool negotiating, Guid? sessionFamily = null)
    {
        lock (_gate)
        {
            if (!_sessions.TryGetValue(sessionId, out var session) || session.UserId != userId)
            {
                return null;
            }

            var now = time.GetUtcNow();
            if (session.ParentSessionId is { } parentId
                && (session.SessionFamily != sessionFamily || session.RevokePending
                    || !HasScreenParentLocked(parentId, userId, session.AgentId, sessionFamily, now)))
            {
                return null;
            }

            return negotiating && now - session.OpenedAt > TokenLifetime ? null : session;
        }
    }

    /// <summary>Tira a sessão (fechamento pedido pela pessoa dela); outra pessoa não a acha.</summary>
    public PcRtcSession? TakeOwned(Guid sessionId, Guid userId, Guid? sessionFamily = null)
    {
        lock (_gate)
        {
            if (!_sessions.TryGetValue(sessionId, out var session) || session.UserId != userId
                || sessionFamily is not null && session.Scopes == PcRtcScopes.Screen && session.SessionFamily != sessionFamily)
            {
                return null;
            }

            Forget(session);
            return session;
        }
    }

    /// <summary>Tira a sessão que o agente diz ter fechado; só vale se ela é mesmo daquele agente.</summary>
    public PcRtcSession? TakeForAgent(string agentSlug, Guid sessionId)
    {
        lock (_gate)
        {
            if (!_sessions.TryGetValue(sessionId, out var session)
                || !string.Equals(session.AgentSlug, agentSlug, StringComparison.Ordinal))
            {
                return null;
            }

            Forget(session);
            return session;
        }
    }

    /// <summary>As sessões de uma pessoa que cumprem a condição (a sessão, a senha, a conta ou a permissão dela mudou), sem tirá-las.</summary>
    public IReadOnlyList<PcRtcSession> FindWhere(Guid userId, Func<PcRtcSession, bool> match)
    {
        lock (_gate)
        {
            return _sessions.Values.Where(s => s.UserId == userId && match(s)).ToList();
        }
    }

    /// <summary>Marca a sessão cuja revogação não alcançou o agente: ela fica no registro e o aviso é refeito quando o agente volta.</summary>
    public void MarkRevokePending(Guid sessionId, string? agentSlug = null)
    {
        lock (_gate)
        {
            // Com o agente dado, só marca a sessão DELE: um id alheio (um bilhete inválido que cita a sessão de outro PC) não marca a de ninguém.
            if (_sessions.TryGetValue(sessionId, out var session)
                && (agentSlug is null || string.Equals(session.AgentSlug, agentSlug, StringComparison.Ordinal)))
            {
                _sessions[sessionId] = session with { RevokePending = true };
            }
        }
    }

    /// <summary>As sessões deste PC com a revogação por refazer, sem tirá-las (só saem depois de o aviso chegar).</summary>
    public IReadOnlyList<PcRtcSession> RevokePendingForAgent(string agentSlug)
    {
        lock (_gate)
        {
            return _sessions.Values
                .Where(s => s.RevokePending && string.Equals(s.AgentSlug, agentSlug, StringComparison.Ordinal))
                .ToList();
        }
    }

    /// <summary>As sessões abertas de um PC, sem tirá-las (quem as substitui só as tira depois de o agente aceitar a oferta nova).</summary>
    public IReadOnlyList<PcRtcSession> ForAgent(string agentSlug)
    {
        lock (_gate)
        {
            return _sessions.Values.Where(s => string.Equals(s.AgentSlug, agentSlug, StringComparison.Ordinal)).ToList();
        }
    }

    /// <summary>
    /// Há um canal VIVO de outra pessoa neste PC? Um canal nunca vive mais que <see cref="PcRtcHandler.MaxLifetime"/> (mais a janela da
    /// negociação), então uma sessão mais velha que isso é de um agente que caiu sem avisar e não segura ninguém.
    /// </summary>
    public bool HasLiveSessionOfAnother(string agentSlug, Guid userId)
    {
        var now = time.GetUtcNow();
        lock (_gate)
        {
            return HasLiveOfAnotherLocked(agentSlug, userId, now);
        }
    }

    /// <summary>Tira todas as sessões abertas de um PC (uma oferta nova substitui a anterior: no máximo uma por PC).</summary>
    public IReadOnlyList<PcRtcSession> TakeAllForAgent(string agentSlug)
    {
        lock (_gate)
        {
            var found = _sessions.Values.Where(s => string.Equals(s.AgentSlug, agentSlug, StringComparison.Ordinal)).ToList();
            foreach (var session in found)
            {
                Forget(session);
            }

            return found;
        }
    }
}
