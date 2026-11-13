using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.Tokens;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Features.RemoteCare;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Tv.Contracts;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>
/// O pedido do canal: a oferta SDP e o que o app quer levar por ele. <paramref name="Scopes"/> são <c>pc</c> e/ou <c>tv</c> (sem
/// eles, só o PC, como sempre foi) e <paramref name="TvId"/> a TV (sem ela, a única ou a padrão que a pessoa vê). A API só concede o
/// que a pessoa pode agora: o que não puder cai sem erro e a resposta diz o que ficou.
/// </summary>
internal sealed record PcRtcOfferRequest(string? Sdp, string[]? Scopes = null, Guid? TvId = null);

/// <summary>O que um canal direto pode levar: o PC (ponteiro, teclado, mídia) e/ou as teclas e o texto da TV do agente.</summary>
[Flags]
internal enum PcRtcScopes
{
    None = 0,
    Pc = 1,
    Tv = 2,
}

internal static class PcRtcScopeNames
{
    public const string Pc = "pc";
    public const string Tv = "tv";

    /// <summary>Os nomes do contrato, na ordem fixa (<c>pc</c> antes de <c>tv</c>).</summary>
    public static string[] ToWire(PcRtcScopes scopes) =>
    [
        .. scopes.HasFlag(PcRtcScopes.Pc) ? [Pc] : Array.Empty<string>(),
        .. scopes.HasFlag(PcRtcScopes.Tv) ? [Tv] : Array.Empty<string>(),
    ];

    /// <summary>Sem a lista, o pedido é só do PC (o app anterior ao escopo); nome desconhecido vira <see cref="PcRtcScopes.None"/>.</summary>
    public static PcRtcScopes Parse(IEnumerable<string>? names)
    {
        if (names is null)
        {
            return PcRtcScopes.Pc;
        }

        var scopes = PcRtcScopes.None;
        foreach (var name in names)
        {
            scopes |= name switch
            {
                Pc => PcRtcScopes.Pc,
                Tv => PcRtcScopes.Tv,
                _ => PcRtcScopes.None,
            };
        }

        return scopes;
    }
}

/// <summary>O TOTAL de segundos com tecla ou mouse que o app mandou por este canal desde que ele abriu (a parte "direta" da paridade).</summary>
internal sealed record PcRtcUsageRequest(int? TotalSeconds);

internal sealed record PcRtcCandidateRequest(string? Candidate, string? SdpMid, int? SdpMLineIndex);

/// <summary>A resposta da oferta: o SDP do agente (com a impressão digital DTLS dele), o token que a primeira mensagem do canal apresenta e os escopos que o canal ficou com (o que a pessoa pode agora).</summary>
internal sealed record PcRtcOfferResponse(Guid SessionId, string Sdp, string Token, int ExpiresInSeconds, string[] Scopes);

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
    Guid? TvId = null);

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

/// <summary>Os limites do que o app pode pedir: o que a API deixaria passar e o contrato recusasse viraria 500 em vez de 400.</summary>
internal static class PcRtcValidator
{
    public const int MaxSdp = 16_384;
    public const int MaxCandidate = 512;

    public static Dictionary<string, string[]> Offer(PcRtcOfferRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        var sdp = request?.Sdp;
        if (string.IsNullOrWhiteSpace(sdp))
        {
            errors["sdp"] = ["Informe a oferta do canal."];
        }
        else if (sdp.Length > MaxSdp)
        {
            errors["sdp"] = [$"A oferta deve ter no máximo {MaxSdp} caracteres."];
        }
        else if (!sdp.StartsWith("v=0", StringComparison.Ordinal)
            || !sdp.Contains("a=fingerprint:", StringComparison.Ordinal)
            || !sdp.Contains("m=application", StringComparison.Ordinal))
        {
            // Só um canal de dados com a impressão digital DTLS: é ela que prende o par à sinalização autenticada.
            errors["sdp"] = ["A oferta precisa ser de um canal de dados, com a impressão digital DTLS."];
        }

        if (request?.Scopes is { } scopes
            && (scopes.Length is 0 or > 2 || scopes.Distinct(StringComparer.Ordinal).Count() != scopes.Length
                || scopes.Any(name => name is not (PcRtcScopeNames.Pc or PcRtcScopeNames.Tv))))
        {
            errors["scopes"] = ["Use pc e/ou tv, sem repetir."];
        }

        if (request?.TvId == Guid.Empty)
        {
            errors["tvId"] = ["Informe a TV."];
        }

        return errors;
    }

    public static Dictionary<string, string[]> Candidate(PcRtcCandidateRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        var candidate = request?.Candidate;
        if (string.IsNullOrWhiteSpace(candidate) || candidate.Length > MaxCandidate
            || !candidate.StartsWith("candidate:", StringComparison.Ordinal) || candidate.Any(char.IsControl))
        {
            errors["candidate"] = ["Informe um candidato ICE válido."];
        }

        if (request?.SdpMid is { Length: > 32 })
        {
            errors["sdpMid"] = ["Use até 32 caracteres."];
        }

        if (request?.SdpMLineIndex is < 0 or > 8)
        {
            errors["sdpMLineIndex"] = ["Use de 0 a 8."];
        }

        return errors;
    }
}

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

            previous = _sessions.Values.Where(s => string.Equals(s.AgentSlug, agentSlug, StringComparison.Ordinal)).ToList();
            return OpenLocked(userId, agentId, agentSlug, sessionFamily, scopes, tvId, now);
        }
    }

    private PcRtcSession OpenLocked(
        Guid userId, Guid agentId, string agentSlug, Guid? sessionFamily, PcRtcScopes scopes, Guid? tvId, DateTimeOffset now)
    {
        var session = new PcRtcSession(Guid.CreateVersion7(), userId, agentId, agentSlug, now, sessionFamily, Scopes: scopes, TvId: tvId);
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
            && string.Equals(s.AgentSlug, agentSlug, StringComparison.Ordinal)
            && now - s.OpenedAt <= PcRtcHandler.MaxLifetime + TokenLifetime);

    /// <summary>Tira a sessão do registro e, se levava a TV, a lembra por pouco tempo (a soma do agente ainda vai chegar).</summary>
    private void Forget(PcRtcSession session)
    {
        _sessions.Remove(session.Id);
        Remember(session.Id);
        RememberUsage(session);
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
            return live.UserId == userId && now - live.OpenedAt <= PcRtcHandler.MaxLifetime + TokenLifetime
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

            if (_sessions.Values.Any(s => string.Equals(s.AgentSlug, claimed.AgentSlug, StringComparison.Ordinal)))
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
    public PcRtcSession? Get(Guid sessionId, Guid userId, bool negotiating)
    {
        lock (_gate)
        {
            if (!_sessions.TryGetValue(sessionId, out var session) || session.UserId != userId)
            {
                return null;
            }

            return negotiating && time.GetUtcNow() - session.OpenedAt > TokenLifetime ? null : session;
        }
    }

    /// <summary>Tira a sessão (fechamento pedido pela pessoa dela); outra pessoa não a acha.</summary>
    public PcRtcSession? TakeOwned(Guid sessionId, Guid userId)
    {
        lock (_gate)
        {
            if (!_sessions.TryGetValue(sessionId, out var session) || session.UserId != userId)
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

/// <summary>
/// Quem espera a resposta SDP do agente. O pedido registra a espera ANTES de mandar a oferta (a resposta pode chegar antes do
/// resultado do comando) e a mensagem <c>pc.rtc.answer.v1</c> a completa. Em memória e da instância: o pedido e a resposta
/// do agente passam pela mesma instância, porque o agente tem uma conexão só.
/// </summary>
internal sealed class PcRtcAnswers(TimeProvider time)
{
    private readonly ConcurrentDictionary<(string Slug, Guid SessionId), TaskCompletionSource<string>> _waiting = new();

    public Pending Expect(string agentSlug, Guid sessionId)
    {
        var source = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        _waiting[(agentSlug, sessionId)] = source;
        return new Pending(this, (agentSlug, sessionId), source, time);
    }

    public void Complete(string agentSlug, Guid sessionId, string sdp)
    {
        if (_waiting.TryRemove((agentSlug, sessionId), out var source))
        {
            source.TrySetResult(sdp);
        }
    }

    internal sealed class Pending(
        PcRtcAnswers owner, (string, Guid) key, TaskCompletionSource<string> source, TimeProvider time) : IDisposable
    {
        public async Task<string?> WaitAsync(TimeSpan timeout, CancellationToken cancellationToken)
        {
            try
            {
                return await source.Task.WaitAsync(timeout, time, cancellationToken);
            }
            catch (TimeoutException)
            {
                return null;
            }
        }

        public void Dispose() => owner._waiting.TryRemove(key, out _);
    }
}

/// <summary>Registra na trilha o fechamento do canal que o agente avisou (a sessão sai da memória uma vez só).</summary>
internal sealed class PcRtcClosures(
    PcRtcSessions sessions, PairingAuditWriter audit, DevicesDbContext db, IAgentGateway gateway, ITvDirectChannels? tv = null)
{
    /// <summary>
    /// O agente voltou: refaz o fechamento "revogado" das sessões cujo aviso não o alcançou na queda. Só sai do registro o que o aviso de
    /// fato alcançou; o que falhar de novo segue marcado para a próxima volta.
    /// </summary>
    public async Task RetryRevocationsAsync(string agentSlug, CancellationToken cancellationToken)
    {
        var closed = 0;
        foreach (var session in sessions.RevokePendingForAgent(agentSlug))
        {
            var sent = await gateway.SendAsync(agentSlug, PcMessages.RtcClose(session.Id, PcRtcCloseV1BodyReason.Revoked), cancellationToken);
            if (sent.IsSuccess && sessions.TakeOwned(session.Id, session.UserId) is not null)
            {
                audit.Add(PairingEvents.PcDirectClosed, new ClientInfo(null, null), agentId: session.AgentId, userId: session.UserId);
                closed++;
            }
        }

        if (closed > 0)
        {
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    /// <summary>
    /// O agente avisou que o canal fechou. Se a sessão ainda estava no registro, grava o fechamento. Se levava a TV, o agente manda também
    /// a soma de teclas e textos, e ela vai para a trilha da TV (mesmo quando foi a API que mandou fechar, e a sessão já saiu daqui).
    /// </summary>
    public async Task AgentClosedAsync(
        string agentSlug, Guid sessionId, string? reason, int? tvKeys, int? tvTexts, CancellationToken cancellationToken)
    {
        var live = sessions.TakeForAgent(agentSlug, sessionId);
        var session = live ?? sessions.TakeClosedTv(agentSlug, sessionId);
        if (session is null)
        {
            return;
        }

        if (live is not null)
        {
            audit.Add(PairingEvents.PcDirectClosed, new ClientInfo(null, null), agentId: session.AgentId, userId: session.UserId);
            await db.SaveChangesAsync(cancellationToken);
        }

        if (session.TvId is { } tvId && tv is not null && tvKeys is not null && tvTexts is not null)
        {
            await PcRtcTvTrail.RecordAsync(
                tv, new TvDirectUse(session.UserId, tvId, session.AgentSlug, tvKeys.Value, tvTexts.Value, reason ?? "closed", null, null), cancellationToken);
        }
    }
}

/// <summary>A trilha da TV de um canal direto: nunca impede o canal nem a resposta (a trilha da TV só falha para o registro).</summary>
internal static class PcRtcTvTrail
{
    public static async Task RecordAsync(ITvDirectChannels tv, TvDirectUse use, CancellationToken cancellationToken)
    {
        try
        {
            await tv.RecordUseAsync(use, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
#pragma warning disable CA1031 // A trilha da TV é um efeito colateral: a falha dela não pode derrubar o canal.
        catch (Exception)
#pragma warning restore CA1031
        {
            // O Tv já registra a falha da própria trilha.
        }
    }
}

/// <summary>
/// O canal direto (WebRTC) entre o app e o PC. A API só faz o papel de sinalização autenticada: confere o que a pessoa pode levar
/// pelo canal (o PC dela, se tem <c>module:pc</c>; e/ou as teclas e o texto de uma TV que ela pode controlar, se tem <c>tv:control</c>
/// e a TV é dela, decidido pelo módulo TV agora), repassa a oferta ao agente pelo canal que já existe, devolve a resposta (com a
/// impressão digital DTLS) e um token de uso único e vida curta, que a primeira mensagem do canal precisa apresentar. Os escopos
/// concedidos vão na oferta e o agente só os aplica. Nenhum SDP é guardado nem vai para o registro, e o token só passa daqui para o
/// agente e para o app.
/// </summary>
internal sealed class PcRtcHandler(
    PcAgentResolver resolver,
    IAgentGateway gateway,
    PcRtcSessions sessions,
    PcRtcAnswers answers,
    PairingAuditWriter audit,
    DevicesDbContext db,
    PcOriginReader origins,
    PcDeviceStates deviceStates,
    IAccessGrants grants,
    ITvDirectChannels? tv = null,
    PcRtcTickets? tickets = null,
    TimeProvider? time = null)
{
    /// <summary>O agente carrega a biblioteca na primeira oferta (cerca de um segundo) e junta os candidatos; o prazo dele é de 12 s, e o desta espera é maior para a recusa dele chegar antes.</summary>
    public static readonly TimeSpan OfferTimeout = TimeSpan.FromSeconds(15);

    /// <summary>Depois do resultado do comando a resposta já devia ter chegado (ela sai antes); uma folga curta basta.</summary>
    public static readonly TimeSpan AnswerGrace = TimeSpan.FromSeconds(2);

    /// <summary>O código com que o agente recusa a oferta de uma sessão que a API já mandou fechar.</summary>
    public const string RtcClosedCode = "rtc_closed";

    /// <summary>A vida máxima de um canal: o que resta do token de acesso da pessoa, entre estes limites.</summary>
    public static readonly TimeSpan MinLifetime = TimeSpan.FromSeconds(60);

    public static readonly TimeSpan MaxLifetime = TimeSpan.FromMinutes(15);

    /// <param name="isOwner">O administrador: o único que toma o canal de outra pessoa (um convidado nunca derruba o canal de ninguém).</param>
    /// <param name="lifetime">O que resta do token de acesso desta requisição: o canal nunca vive mais que ele.</param>
    /// <param name="sessionFamily">A sessão (família do refresh) da requisição; o canal fecha quando ela acaba.</param>
    public async Task<IResult> OfferAsync(
        Guid userId,
        bool isOwner,
        Guid? sessionFamily,
        TimeSpan lifetime,
        PcRtcOfferRequest request,
        ClientInfo client,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        // Falta menos que o piso do token de acesso: um canal de 60 s que sobrevive ao token que o autorizou não existe. O app
        // renova o token (o 401 faz isso) e oferece de novo.
        if (lifetime < MinLifetime)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        var requested = PcRtcScopeNames.Parse(request.Scopes);
        var granted = PcRtcScopes.None;
        PcTarget? target = null;
        Guid? tvId = null;
        var allowed = false;

        // A TV: quem decide a permissão e a filiação é o módulo TV, agora; o agente do canal é o da TV.
        if (requested.HasFlag(PcRtcScopes.Tv) && tv is not null
            && await tv.ResolveAsync(userId, isOwner, request.TvId, cancellationToken) is { } tvTarget)
        {
            allowed = true;
            if (await resolver.ResolveBySlugAsync(tvTarget.AgentSlug, cancellationToken) is { } tvAgent)
            {
                target = tvAgent;
                tvId = tvTarget.TvId;
                granted |= PcRtcScopes.Tv;
            }
        }

        // O PC: a permissão do módulo e o computador da própria pessoa. Se o canal já é do agente da TV, o PC só entra se for o mesmo.
        if (requested.HasFlag(PcRtcScopes.Pc) && await grants.HasAsync(userId, AccessPermissions.PcModule, cancellationToken))
        {
            allowed = true;
            var pc = await resolver.ResolveAsync(userId, cancellationToken);
            if (pc is not null && (target is null || string.Equals(pc.Slug, target.Slug, StringComparison.Ordinal)))
            {
                target = pc;
                granted |= PcRtcScopes.Pc;
            }
            else if (pc is null && target is null)
            {
                return PcProblems.Unavailable();
            }
        }

        if (!allowed)
        {
            return PcProblems.DirectForbidden();
        }

        if (target is null || granted == PcRtcScopes.None)
        {
            // A TV é dela mas o computador não existe mais (ou nunca conectou): é o mesmo "fora do ar" das outras rotas.
            return RemoteCareProblems.Offline();
        }

        if (!target.Connected)
        {
            return RemoteCareProblems.Offline();
        }

        if (!OffersDirect(target))
        {
            return PcProblems.DirectUnavailable();
        }

        // O escopo da TV só vai a quem declara `tv.rtc.v1` (o esquema da oferta de um agente anterior é fechado); sem ele a TV segue pela nuvem.
        if (granted.HasFlag(PcRtcScopes.Tv) && !target.Capabilities.Contains(PcMessages.TvRtcCapability, StringComparer.Ordinal))
        {
            granted &= ~PcRtcScopes.Tv;
            tvId = null;
            if (granted == PcRtcScopes.None)
            {
                return PcProblems.DirectUnavailable();
            }
        }

        // Um aparelho que o PC já avisou estar pendente ou recusado nem chega a mexer no canal de outro aparelho. Só vale para o PC: o canal só
        // da TV não depende dessa aprovação (a TV pela nuvem também não depende).
        var origin = origins.Read();
        var withPc = granted.HasFlag(PcRtcScopes.Pc);
        if (withPc && origin.DeviceId is not null && deviceStates.RefusalFor(target.Slug, origin.DeviceId) is { } refusal)
        {
            // A aprovação é só do controle do PC. Quando a mesma oferta também pode levar a TV,
            // conservamos esse escopo: o app recebe a lista concedida e não entra em recuo por um
            // aparelho que o dono ainda não aprovou para o PC.
            if (granted.HasFlag(PcRtcScopes.Tv))
            {
                granted &= ~PcRtcScopes.Pc;
                withPc = false;
            }
            else
            {
                return PcProblems.DeviceRefused(refusal);
            }
        }

        // No máximo um canal por PC: a oferta nova substitui a anterior (o agente também troca o par e solta o que segurava). As anteriores
        // só são fechadas e tiradas daqui DEPOIS de o agente aceitar a oferta nova: uma oferta recusada (aparelho pendente ou recusado, canal
        // indisponível) nunca derruba o canal de quem já está usando. O canal de OUTRA pessoa só é tomado pelo administrador: um convidado
        // com a TV de um computador que não é dele nunca derruba o canal de quem usa o PC.
        // A decisão "há canal vivo de outra pessoa?", a captura das sessões a substituir e a abertura são UMA operação no registro: duas
        // ofertas ao mesmo tempo não passam as duas, e a lista a fechar depois é exatamente a que estava lá no instante da abertura.
        var session = sessions.TryOpen(userId, isOwner, target.AgentId, target.Slug, sessionFamily, granted, tvId, out var previous);
        if (session is null)
        {
            return PcProblems.DirectBusy();
        }

        var token = NewToken();
        using var pending = answers.Expect(target.Slug, session.Id);
        var maxLifetime = (int)Math.Min(lifetime.TotalSeconds, MaxLifetime.TotalSeconds);
        // Sem o escopo da TV a oferta é a de sempre (sem o campo): é a única que um agente anterior entende.
        var scopes = granted == PcRtcScopes.Pc ? null : PcRtcScopeNames.ToWire(granted);
        // Quem sabe reconciliar (reconectar depois de a API reiniciar) leva um bilhete assinado pela API, que o agente só guarda e devolve; o
        // esquema da oferta de um agente anterior é fechado, então o campo nem sai para ele. Sem a sessão de login não há bilhete (a API
        // não teria como saber se ela ainda vale): o canal, se sobreviver a uma reinicialização, é reaberto pelo app.
        var reconcilable = tickets is not null
            && sessionFamily is not null
            && target.Capabilities.Contains(PcMessages.RtcReconcileCapability, StringComparer.Ordinal);
        var issuedAt = time?.GetUtcNow() ?? DateTimeOffset.UtcNow;
        var ticket = reconcilable
            ? tickets!.Issue(new PcRtcTicketClaims(
                session.Id,
                userId,
                sessionFamily,
                withPc ? origin.DeviceId : null,
                granted,
                granted.HasFlag(PcRtcScopes.Tv) ? tvId : null,
                target.Slug,
                issuedAt,
                issuedAt + TimeSpan.FromSeconds(maxLifetime) + PcRtcSessions.TokenLifetime))
            : null;
        var message = PcMessages.RtcOffer(
            session.Id,
            request.Sdp!,
            token,
            (int)PcRtcSessions.TokenLifetime.TotalSeconds,
            maxLifetime,
            scopes,
            ticket);

        // A oferta leva o aparelho (a aprovação no PC); o canal herda a decisão. Sem a capacidade, ou sem o escopo do PC, o campo nem sai.
        if (withPc)
        {
            message = PcMessages.WithOrigin(message, target.Capabilities, origin, withOperation: false);
        }

        var reply = await gateway.RequestAsync(target.Slug, message, OfferTimeout, cancellationToken);
        if (reply.IsFailure)
        {
            sessions.TakeOwned(session.Id, userId);
            return PcProblems.FromGateway(reply.Error);
        }

        if (!reply.Value.Ok)
        {
            sessions.TakeOwned(session.Id, userId);
            // O agente já tinha o fechamento desta sessão (a revogação passou na frente da oferta): é a mesma resposta de quando a
            // revogação é descoberta depois, e o app não insiste.
            if (PcProblems.IsDeviceRefusal(reply.Value.Error?.Code))
            {
                // A decisão do aparelho só vale para PC. O agente pode ser o primeiro a saber que ele está pendente ou recusado (a API ainda
                // não o sabia); refazemos a oferta apenas para a TV. O mesmo SDP serve: o agente recusa pelo aparelho ANTES de criar o par,
                // então nada ficou negociado. Só quando a oferta tinha o PC E a TV: a oferta só da TV não passa pela aprovação do aparelho,
                // e um código desses vindo dela é do agente, não de algo a refazer (e não pode entrar em laço).
                if (granted.HasFlag(PcRtcScopes.Pc) && granted.HasFlag(PcRtcScopes.Tv))
                {
                    return await OfferAsync(
                        userId, isOwner, sessionFamily, lifetime,
                        request with { Scopes = [PcRtcScopeNames.Tv] }, client, cancellationToken);
                }
                return PcProblems.DeviceRefused(reply.Value.Error!.Code);
            }

            // `rtc_closed` é a recusa de antes da troca do par (a sessão já tinha sido fechada): as anteriores seguem. Só `rtc_failed` e
            // `rtc_unavailable` vêm depois de o agente ter lido a oferta e podido trocar o par: aí o registro acompanha (como sempre foi).
            if (reply.Value.Error?.Code != RtcClosedCode)
            {
                await ReplacePreviousAsync(previous, target.Slug, client, cancellationToken);
            }

            return reply.Value.Error?.Code == RtcClosedCode
                ? PcProblems.DirectRevoked()
                : RemoteCareProblems.CommandFailed(reply.Value.Error?.Code);
        }

        // O agente aceitou a oferta e trocou o par: agora sim as anteriores saem do registro, com o aviso e a trilha.
        await ReplacePreviousAsync(previous, target.Slug, client, cancellationToken);

        // A permissão pode ter caído entre a primeira conferência e a aceitação do agente (o ouvinte de revogação não achava a sessão: ela
        // ainda não estava aceita). Reconfere com a MESMA regra da oferta (e do reconcile); se algum escopo caiu, nada do canal chega ao app.
        // As anteriores já saíram acima: o agente as trocou ao aceitar, e elas não podem ficar no registro segurando o PC.
        if (await PcRtcRights.StillValidAsync(resolver, grants, tv, userId, isOwner, granted, tvId, target.Slug, cancellationToken) != granted)
        {
            sessions.TakeOwned(session.Id, userId);
            await CloseWithoutRequestAsync(target.Slug, session.Id);
            return PcProblems.DirectRevoked();
        }

        var answer = await pending.WaitAsync(AnswerGrace, cancellationToken);
        if (answer is null)
        {
            sessions.TakeOwned(session.Id, userId);
            return RemoteCareProblems.Timeout();
        }

        // A negociação leva segundos, e a sessão pode ter sido revogada nesse meio (o ouvinte a tirou daqui e mandou o fechamento,
        // que pode ter passado na frente da oferta no agente): nada do canal chega ao app, e o agente é avisado outra vez.
        if (sessions.Get(session.Id, userId, negotiating: false) is null)
        {
            await CloseWithoutRequestAsync(target.Slug, session.Id);
            return PcProblems.DirectRevoked();
        }

        // A trilha diz que o canal foi negociado e entregue (ele só abre depois, direto entre o app e o PC) e nunca leva SDP nem token.
        audit.Add(PairingEvents.PcDirectOpened, client, agentId: target.AgentId, userId: userId);
        await db.SaveChangesAsync(cancellationToken);
        if (tvId is { } openedTv && tv is not null)
        {
            // A trilha da TV: o canal com o escopo da TV abriu (a soma do que ele levar vem ao fechar).
            await PcRtcTvTrail.RecordAsync(
                tv, new TvDirectUse(userId, openedTv, target.Slug, 0, 0, TvDirectUseReasons.Opened, client.Ip, client.UserAgent), cancellationToken);
        }

        return TypedResults.Ok(new PcRtcOfferResponse(
            session.Id, answer, token, (int)PcRtcSessions.TokenLifetime.TotalSeconds, PcRtcScopeNames.ToWire(granted)));
    }

    private async Task ReplacePreviousAsync(
        IReadOnlyList<PcRtcSession> previous, string agentSlug, ClientInfo client, CancellationToken cancellationToken)
    {
        foreach (var old in previous)
        {
            if (sessions.TakeOwned(old.Id, old.UserId) is null)
            {
                continue;
            }

            await gateway.SendAsync(agentSlug, PcMessages.RtcClose(old.Id, PcRtcCloseV1BodyReason.Replaced), cancellationToken);
            audit.Add(PairingEvents.PcDirectClosed, client, agentId: old.AgentId, userId: old.UserId);
            // Grava já: o fechamento do canal anterior não pode se perder se algo falhar adiante.
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    public async Task<IResult> CandidateAsync(
        Guid userId, Guid sessionId, PcRtcCandidateRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (sessions.Get(sessionId, userId, negotiating: true) is not { } session)
        {
            return PcProblems.DirectExpired();
        }

        var sent = await gateway.SendAsync(
            session.AgentSlug,
            PcMessages.RtcCandidate(sessionId, request.Candidate!, request.SdpMid, request.SdpMLineIndex),
            cancellationToken);
        return sent.IsSuccess ? TypedResults.NoContent() : PcProblems.FromGateway(sent.Error);
    }

    /// <summary>Fecha o canal da sessão. Quem não é dono dela (ou sessão que já fechou) recebe "não existe": nada vaza.</summary>
    public async Task<IResult> CloseAsync(Guid userId, Guid sessionId, ClientInfo client, CancellationToken cancellationToken)
    {
        if (sessions.TakeOwned(sessionId, userId) is not { } session)
        {
            return TypedResults.NotFound();
        }

        // Falhar o aviso (o PC caiu) não impede o registro: o canal já morreu junto com a conexão do agente.
        await gateway.SendAsync(session.AgentSlug, PcMessages.RtcClose(sessionId, PcRtcCloseV1BodyReason.Requested), cancellationToken);
        audit.Add(PairingEvents.PcDirectClosed, client, agentId: session.AgentId, userId: userId);
        await db.SaveChangesAsync(cancellationToken);
        return TypedResults.NoContent();
    }

    /// <summary>O aviso de fechamento depois de a pessoa ter perdido o acesso: com prazo próprio, porque não há mais quem espere a requisição.</summary>
    private async Task CloseWithoutRequestAsync(string agentSlug, Guid sessionId)
    {
        using var timeout = new CancellationTokenSource(PcRtcAccessListener.Timeout);
        try
        {
            await gateway.SendAsync(agentSlug, PcMessages.RtcClose(sessionId, PcRtcCloseV1BodyReason.Revoked), timeout.Token);
        }
        catch (OperationCanceledException)
        {
            // Sem resposta no prazo: a vida máxima do canal no agente é a garantia.
        }
    }

    /// <summary>O PC declarou o canal direto no <c>hello</c> desta sessão (um agente "esperado de volta" não conta: guarda as de antes).</summary>
    private static bool OffersDirect(PcTarget target) =>
        target.HelloAt is not null && target.Capabilities.Contains(PcMessages.RtcCapability, StringComparer.Ordinal);

    /// <summary>32 bytes aleatórios em base64url sem preenchimento: 43 caracteres.</summary>
    private static string NewToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

/// <summary>
/// Fecha, ao ver que a pessoa perdeu um escopo do canal (ou o acesso todo), as sessões que o plano manda: a que ficou sem nada
/// recebe <c>revoked</c> e a que ficou com um escopo recebe <c>rescoped</c> (o app abre outro já, com o que sobrou). Só sai do registro o
/// que o aviso de fato alcançou; o que não alcançou fica marcado e é refeito quando o agente volta.
/// </summary>
internal sealed partial class PcRtcRevoker(
    PcRtcSessions sessions,
    IAgentGateway gateway,
    PairingAuditWriter audit,
    DevicesDbContext db,
    ILogger<PcRtcRevoker> logger) : IPcRtcCloser
{
    /// <summary>Nunca propaga falha: a mudança de acesso já vale, e o que não fechar agora fecha pela vida máxima do canal.</summary>
    public async Task CloseSafelyAsync(IReadOnlyList<(PcRtcSession Session, PcRtcCloseV1BodyReason Reason)> plan, string what)
    {
        try
        {
            using var timeout = new CancellationTokenSource(PcRtcAccessListener.Timeout);
            await CloseAsync(plan, timeout.Token);
        }
#pragma warning disable CA1031 // A mudança de acesso já vale: a falha daqui só vai para o registro.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogCloseFailed(what, ex.GetType().Name);
        }
    }

    public async Task CloseAsync(IReadOnlyList<(PcRtcSession Session, PcRtcCloseV1BodyReason Reason)> plan, CancellationToken cancellationToken)
    {
        var closed = 0;
        try
        {
            foreach (var (session, reason) in plan)
            {
                // Só sai do registro o que o aviso de fato alcançou: sem alcançar o agente (offline, queda), a sessão fica e uma
                // próxima mudança, o aviso dele ou a vida máxima do canal a encerram.
                if (!await TrySendCloseAsync(session, reason, cancellationToken))
                {
                    // O agente não foi alcançado: a sessão fica marcada e a revogação é refeita quando ele voltar (ele pode manter o canal
                    // direto por alguns segundos sem a API, e este é o que impede um canal revogado de viver até a vida máxima).
                    sessions.MarkRevokePending(session.Id, session.AgentSlug);
                    continue;
                }

                if (sessions.TakeOwned(session.Id, session.UserId) is null)
                {
                    continue;
                }

                audit.Add(PairingEvents.PcDirectClosed, new ClientInfo(null, null), agentId: session.AgentId, userId: session.UserId);
                closed++;
            }
        }
        finally
        {
            if (closed > 0)
            {
                // O que já saiu do registro tem a trilha gravada mesmo que o resto tenha estourado o prazo.
                using var saving = new CancellationTokenSource(PcRtcAccessListener.Timeout);
                await db.SaveChangesAsync(saving.Token);
            }
        }
    }

    /// <summary>Manda o fechamento ao agente da sessão; <c>false</c> se ele não foi alcançado (offline, queda ou falha da entrega). Uma sessão não derruba as outras.</summary>
    private async Task<bool> TrySendCloseAsync(PcRtcSession session, PcRtcCloseV1BodyReason reason, CancellationToken cancellationToken)
    {
        try
        {
            var sent = await gateway.SendAsync(session.AgentSlug, PcMessages.RtcClose(session.Id, reason), cancellationToken);
            return sent.IsSuccess;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
#pragma warning disable CA1031 // O aviso a um agente não pode impedir o dos outros: o canal que ficou fecha pela vida máxima dele.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogSendFailed(ex.GetType().Name);
            return false;
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "O fechamento dos canais diretos do PC falhou ({Kind}, {Error}).")]
    private partial void LogCloseFailed(string kind, string error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "O aviso de fechamento do canal direto não saiu ({Error}).")]
    private partial void LogSendFailed(string error);
}

/// <summary>
/// O canal direto não passa pela API a cada comando, então não perceberia sozinho que a pessoa deixou de poder usá-lo. Aqui ele
/// fecha na hora quando a sessão que o abriu acaba (sair, "sair de todos", senha trocada ou recuperada, aparelho revogado), a
/// conta é pausada ou revogada, ou uma permissão que ele usa é retirada: o módulo do PC (o escopo <c>pc</c>), o da TV ou o controle
/// da TV (o escopo <c>tv</c>). Perder um escopo e manter o outro REABRE o canal só com o que sobrou (<c>rescoped</c>); perder o último fecha
/// (<c>revoked</c>). O agente solta o que o PC segurava, e a trilha grava o fechamento. Em processo, como os caches de permissão do
/// Identity; um canal de outra instância vale em até a vida máxima dele.
/// </summary>
internal sealed class PcRtcAccessListener(PcRtcSessions sessions, PcRtcRevoker revoker) : IUserAccessListener
{
    /// <summary>O prazo do ouvinte inteiro (e de cada gravação): a mudança de acesso já está gravada e ninguém mais espera por ele.</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    public async Task ChangedAsync(UserAccessChange change, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(change);

        var plan = sessions.FindWhere(change.UserId, session => ReasonFor(change, session) is not null)
            .Select(session => (session, ReasonFor(change, session)!.Value))
            .ToList();
        if (plan.Count > 0)
        {
            await revoker.CloseSafelyAsync(plan, change.Kind.ToString());
        }
    }

    /// <summary>O motivo de fechar a sessão com esta mudança, ou nulo se ela não a afeta.</summary>
    internal static PcRtcCloseV1BodyReason? ReasonFor(UserAccessChange change, PcRtcSession session) => change.Kind switch
    {
        UserAccessChangeKind.SessionEnded => session.SessionFamily == change.SessionId ? PcRtcCloseV1BodyReason.Revoked : null,
        UserAccessChangeKind.SessionsEnded => change.SessionId is null || session.SessionFamily != change.SessionId
            ? PcRtcCloseV1BodyReason.Revoked
            : null,
        UserAccessChangeKind.AccountDisabled => PcRtcCloseV1BodyReason.Revoked,
        UserAccessChangeKind.ModuleRemoved => ReasonForLost(session, change.Module switch
        {
            AccessPermissions.PcModule => PcRtcScopes.Pc,
            AccessPermissions.TvModule => PcRtcScopes.Tv,
            _ => PcRtcScopes.None,
        }),
        UserAccessChangeKind.PermissionRemoved => ReasonForLost(session, change.Permission == AccessPermissions.TvControl ? PcRtcScopes.Tv : PcRtcScopes.None),
        _ => null,
    };

    /// <summary>Sem nada do que se perdeu, a sessão fica; sem nada do que sobrou, fecha; com algo, reabre com o que sobrou.</summary>
    private static PcRtcCloseV1BodyReason? ReasonForLost(PcRtcSession session, PcRtcScopes lost)
    {
        if (lost == PcRtcScopes.None || (session.Scopes & lost) == PcRtcScopes.None)
        {
            return null;
        }

        return (session.Scopes & ~lost) == PcRtcScopes.None ? PcRtcCloseV1BodyReason.Revoked : PcRtcCloseV1BodyReason.Rescoped;
    }
}

/// <summary>
/// O módulo TV avisa, pela outbox, que pessoas deixaram de poder controlar a TV de um computador (filiação retirada, TV apagada ou
/// computador trocado). Os canais delas com o escopo da TV fecham ou reabrem com o que sobrou, como na perda da permissão. A entrega é
/// "pelo menos uma vez": fechar o que já fechou não faz nada, e uma falha NÃO é engolida (a outbox repete). O que o agente não alcança
/// fica marcado e é refeito quando ele volta.
/// </summary>
internal sealed class TvDirectAccessRemovedHandler(PcRtcSessions sessions, PcRtcRevoker revoker) : IIntegrationEventHandler<TvDirectAccessRemoved>
{
    public async Task HandleAsync(TvDirectAccessRemoved integrationEvent, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(integrationEvent);

        var plan = PlanFor(sessions, integrationEvent);
        if (plan.Count > 0)
        {
            await revoker.CloseAsync(plan, cancellationToken);
        }
    }

    /// <summary>
    /// A folga entre o instante do aviso e a abertura de um canal para ele ser poupado. O aviso registra o instante ANTES do commit da
    /// retirada, e uma oferta que leu a visibilidade antiga um instante antes do commit abre o canal DEPOIS desse instante: poupá-la ao
    /// pé da letra deixaria passar um canal sem direito. Só se poupa o que abriu bem depois. O caso retirar e readicionar em menos de
    /// um minuto fecha também o canal novo, o que só custa disponibilidade do canal direto (a TV segue pela nuvem).
    /// </summary>
    internal static readonly TimeSpan ReopenGrace = TimeSpan.FromSeconds(60);

    /// <summary>
    /// O que fechar: as sessões do computador com o escopo da TV, das pessoas do aviso, exceto as abertas bem depois do aviso
    /// (<see cref="ReopenGrace"/>). O aviso pode chegar tarde (a outbox repete); se a pessoa foi retirada e readicionada antes da
    /// entrega, o canal que ela abriu muito depois da retirada é legítimo e não leva <c>revoked</c>. Aviso sem instante (<c>default</c>,
    /// como um gravado antes de o campo existir) fecha tudo, como sempre fechou.
    /// </summary>
    internal static List<(PcRtcSession Session, PcRtcCloseV1BodyReason Reason)> PlanFor(PcRtcSessions sessions, TvDirectAccessRemoved integrationEvent)
    {
        ArgumentNullException.ThrowIfNull(sessions);
        ArgumentNullException.ThrowIfNull(integrationEvent);

        var hasInstant = integrationEvent.OccurredAt != default;
        return sessions.ForAgent(integrationEvent.AgentSlug)
            .Where(session => session.Scopes.HasFlag(PcRtcScopes.Tv)
                && (integrationEvent.UserIds is null || integrationEvent.UserIds.Contains(session.UserId))
                && (!hasInstant || session.OpenedAt <= integrationEvent.OccurredAt + ReopenGrace))
            .Select(session => (session, session.Scopes.HasFlag(PcRtcScopes.Pc) ? PcRtcCloseV1BodyReason.Rescoped : PcRtcCloseV1BodyReason.Revoked))
            .ToList();
    }
}

/// <summary>
/// A regra única de "a pessoa ainda pode levar isto pelo canal deste PC": a oferta a usa depois de o agente aceitar, e o reconcile a usa
/// para cada sessão que o agente diz ter aberto. Escopo a escopo: o PC é o módulo <c>module:pc</c> E o computador da própria pessoa; a TV
/// é a que o módulo TV diz que ela pode controlar agora, e que é controlada por este mesmo agente.
/// </summary>
internal static class PcRtcRights
{
    /// <summary>O subconjunto de <paramref name="scopes"/> que ainda vale para <paramref name="userId"/> neste agente.</summary>
    public static async Task<PcRtcScopes> StillValidAsync(
        PcAgentResolver resolver,
        IAccessGrants grants,
        ITvDirectChannels? tv,
        Guid userId,
        bool isOwner,
        PcRtcScopes scopes,
        Guid? tvId,
        string agentSlug,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(resolver);
        ArgumentNullException.ThrowIfNull(grants);

        var valid = PcRtcScopes.None;
        if (scopes.HasFlag(PcRtcScopes.Pc)
            && await grants.HasAsync(userId, AccessPermissions.PcModule, cancellationToken)
            && await resolver.ResolveAsync(userId, cancellationToken) is { } pc
            && string.Equals(pc.Slug, agentSlug, StringComparison.Ordinal))
        {
            valid |= PcRtcScopes.Pc;
        }

        if (scopes.HasFlag(PcRtcScopes.Tv)
            && tv is not null
            && tvId is not null
            && await tv.ResolveAsync(userId, isOwner, tvId, cancellationToken) is { } target
            && target.TvId == tvId
            && string.Equals(target.AgentSlug, agentSlug, StringComparison.Ordinal))
        {
            valid |= PcRtcScopes.Tv;
        }

        return valid;
    }
}

/// <summary>O que o bilhete do canal afirma, tudo decidido pela API na oferta (o agente nunca escreve nele).</summary>
/// <param name="Family">A sessão de login (família do refresh) que abriu o canal; sem ela a oferta não leva bilhete.</param>
/// <param name="DeviceId">O aparelho que a oferta levou ao agente (só com o escopo do PC); o mesmo que a aprovação no PC conferiu.</param>
/// <param name="ExpiresAt">O fim da vida máxima do canal (mais a janela do token): depois disso nem o agente mantém o canal.</param>
internal sealed record PcRtcTicketClaims(
    Guid SessionId,
    Guid UserId,
    Guid? Family,
    string? DeviceId,
    PcRtcScopes Scopes,
    Guid? TvId,
    string AgentSlug,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt);

/// <summary>
/// O bilhete assinado do canal direto: a prova, verificável depois de a API reiniciar, de que ELA abriu aquela sessão para aquela pessoa, com
/// aqueles escopos, neste agente. O agente só o guarda e o devolve em <c>pc.rtc.reconcile.v1</c>; nada do que ele declara além disso é
/// confiado. Formato <c>base64url(carga).base64url(HMAC-SHA256)</c>. A chave é derivada (HKDF, com um contexto próprio) da chave de assinatura
/// do JWT que a API já tem: nenhum segredo novo, e a troca de chave segue a do JWT (a anterior ainda valida). Chave temporária (só em
/// desenvolvimento) faz os bilhetes morrerem no reinício, que é o mesmo que acontece com as sessões.
/// </summary>
internal sealed class PcRtcTickets
{
    private const string Context = "uniover/pc-rtc-ticket/v1";
    private const int MacBytes = 32;

    private readonly byte[] _signing;
    private readonly IReadOnlyList<byte[]> _verifying;

    public PcRtcTickets(JwtKeySet keys)
    {
        ArgumentNullException.ThrowIfNull(keys);
        _signing = Derive(keys.SigningCredentials.Key);
        _verifying = [.. keys.ValidationKeys.Select(Derive)];
    }

    private static byte[] Derive(SecurityKey key) =>
        key is SymmetricSecurityKey symmetric
            ? HKDF.DeriveKey(HashAlgorithmName.SHA256, symmetric.Key, MacBytes, salt: null, info: Encoding.UTF8.GetBytes(Context))
            : throw new InvalidOperationException("A chave de assinatura do JWT precisa ser simétrica.");

    public string Issue(PcRtcTicketClaims claims)
    {
        ArgumentNullException.ThrowIfNull(claims);

        var payload = JsonSerializer.SerializeToUtf8Bytes(new Payload(
            1,
            claims.SessionId,
            claims.UserId,
            claims.Family,
            claims.DeviceId,
            (int)claims.Scopes,
            claims.TvId,
            claims.AgentSlug,
            claims.IssuedAt.ToUnixTimeSeconds(),
            claims.ExpiresAt.ToUnixTimeSeconds()));
        return Base64UrlEncoder.Encode(payload) + "." + Base64UrlEncoder.Encode(HMACSHA256.HashData(_signing, payload));
    }

    /// <summary>As afirmações do bilhete, ou nulo se ele foi adulterado, é de outro formato, não é de uma chave nossa ou já venceu.</summary>
    public PcRtcTicketClaims? Read(string? ticket, DateTimeOffset now)
    {
        if (string.IsNullOrEmpty(ticket) || ticket.Length > 1024)
        {
            return null;
        }

        var dot = ticket.IndexOf('.', StringComparison.Ordinal);
        if (dot <= 0 || dot == ticket.Length - 1)
        {
            return null;
        }

        byte[] payload;
        byte[] mac;
        try
        {
            payload = Base64UrlEncoder.DecodeBytes(ticket[..dot]);
            mac = Base64UrlEncoder.DecodeBytes(ticket[(dot + 1)..]);
        }
        catch (FormatException)
        {
            return null;
        }

        // Percorre todas as chaves (sem parar na primeira que casa): o tempo não diz qual era.
        var signed = false;
        foreach (var key in _verifying)
        {
            signed |= CryptographicOperations.FixedTimeEquals(HMACSHA256.HashData(key, payload), mac);
        }

        if (!signed)
        {
            return null;
        }

        try
        {
            var body = JsonSerializer.Deserialize<Payload>(payload);
            if (body is not { V: 1 } || body.Slug is null)
            {
                return null;
            }

            var claims = new PcRtcTicketClaims(
                body.Sid,
                body.Uid,
                body.Fam,
                body.Dev,
                (PcRtcScopes)body.Sc,
                body.Tv,
                body.Slug,
                DateTimeOffset.FromUnixTimeSeconds(body.Iat),
                DateTimeOffset.FromUnixTimeSeconds(body.Exp));
            return claims.ExpiresAt > now && (int)claims.Scopes is > 0 and <= 3 ? claims : null;
        }
        catch (Exception ex) when (ex is JsonException or ArgumentOutOfRangeException or OverflowException or FormatException)
        {
            // Carga assinada por nós mas fora do intervalo (instante impossível, número grande demais): nada se aproveita.
            return null;
        }
    }

    private sealed record Payload(
        [property: System.Text.Json.Serialization.JsonPropertyName("v")] int V,
        [property: System.Text.Json.Serialization.JsonPropertyName("sid")] Guid Sid,
        [property: System.Text.Json.Serialization.JsonPropertyName("uid")] Guid Uid,
        [property: System.Text.Json.Serialization.JsonPropertyName("fam")] Guid? Fam,
        [property: System.Text.Json.Serialization.JsonPropertyName("dev")] string? Dev,
        [property: System.Text.Json.Serialization.JsonPropertyName("sc")] int Sc,
        [property: System.Text.Json.Serialization.JsonPropertyName("tv")] Guid? Tv,
        [property: System.Text.Json.Serialization.JsonPropertyName("ag")] string? Slug,
        [property: System.Text.Json.Serialization.JsonPropertyName("iat")] long Iat,
        [property: System.Text.Json.Serialization.JsonPropertyName("exp")] long Exp);
}

/// <summary>O canal que o agente diz ter aberto (<c>pc.rtc.reconcile.v1</c>): só o id e o bilhete que a API deu; o resto o bilhete diz.</summary>
internal sealed record PcRtcClaim(Guid SessionId, string Ticket);

/// <summary>O que o reconciliador precisa saber de fora do registro: o agente da conexão e o direito de cada escopo agora.</summary>
internal interface IPcRtcReconcileAuthority
{
    /// <summary>O agente pelo nome, com o que ele declarou no <c>hello</c> desta conexão; nulo se revogado ou desconhecido.</summary>
    Task<PcTarget?> AgentAsync(string slug, CancellationToken cancellationToken);

    /// <summary>O subconjunto de <paramref name="scopes"/> que ainda vale para a pessoa neste agente (a regra única da oferta).</summary>
    Task<PcRtcScopes> ValidScopesAsync(Guid userId, PcRtcScopes scopes, Guid? tvId, string agentSlug, CancellationToken cancellationToken);
}

internal sealed class PcRtcReconcileAuthority(
    PcAgentResolver resolver, IAccessGrants grants, IAccountRoleDirectory? roles = null, ITvDirectChannels? tv = null) : IPcRtcReconcileAuthority
{
    public Task<PcTarget?> AgentAsync(string slug, CancellationToken cancellationToken) => resolver.ResolveBySlugAsync(slug, cancellationToken);

    public async Task<PcRtcScopes> ValidScopesAsync(
        Guid userId, PcRtcScopes scopes, Guid? tvId, string agentSlug, CancellationToken cancellationToken)
    {
        var owner = roles is not null && (await roles.OwnersAmongAsync([userId], cancellationToken)).Contains(userId);
        return await PcRtcRights.StillValidAsync(resolver, grants, tv, userId, owner, scopes, tvId, agentSlug, cancellationToken);
    }
}

/// <summary>Quem fecha as sessões de um plano (avisa o agente, tira do registro e grava a trilha): o <see cref="PcRtcRevoker"/>.</summary>
internal interface IPcRtcCloser
{
    Task CloseAsync(IReadOnlyList<(PcRtcSession Session, PcRtcCloseV1BodyReason Reason)> plan, CancellationToken cancellationToken);
}

/// <summary>
/// O agente reconectou e diz ter um canal direto aberto: a API pode ter reiniciado e perdido o registro dele, e sem o registro uma
/// revogação não acharia o canal (ele viveria até a vida máxima). NADA do que o agente declara é confiado: ele devolve o bilhete que a API
/// assinou na oferta. A sessão só é reconstruída se o bilhete é dela e não venceu, é deste agente (o da conexão) e desta sessão, e se a sessão
/// de login que abriu o canal ainda existe e não foi revogada; então se reconferem as permissões pelas regras da oferta. O que continua
/// valendo é confirmado ao agente (<c>pc.rtc.reconciled.v1</c>); o resto é fechado com <c>revoked</c> (nada sobrou) ou <c>rescoped</c> (sobrou
/// um escopo, e o app abre outro). As lápides em memória são só um reforço: a segurança está no bilhete e na sessão de login. Uma conexão que
/// não declarou a capacidade é ignorada. Falhando no meio, a confirmação não sai e o agente fecha o canal pelo prazo dele.
/// </summary>
internal sealed partial class PcRtcReconciler(
    IPcRtcReconcileAuthority authority,
    ISessionFamilyDirectory families,
    IAgentGateway gateway,
    PcRtcSessions sessions,
    IPcRtcCloser closer,
    PcRtcTickets tickets,
    PcDeviceStates deviceStates,
    TimeProvider time,
    ILogger<PcRtcReconciler> logger)
{
    public async Task ReconcileAsync(string agentSlug, IReadOnlyList<PcRtcClaim> claims, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(claims);

        if (claims.Count == 0 || await authority.AgentAsync(agentSlug, cancellationToken) is not { Connected: true } agent)
        {
            return;
        }

        // Só quem declarou a capacidade no `hello` desta conexão reconcilia: um agente anterior (ou um token de agente que a API não conhece
        // assim) nunca tem canal reconstruído por aqui.
        if (!agent.Capabilities.Contains(PcMessages.RtcReconcileCapability, StringComparer.Ordinal))
        {
            LogIgnored();
            return;
        }

        var close = new List<(PcRtcSession Session, PcRtcCloseV1BodyReason Reason)>();
        var kept = new List<PcRtcSession>();
        foreach (var claim in claims)
        {
            var now = time.GetUtcNow();
            var ticket = tickets.Read(claim.Ticket, now);
            if (ticket is null
                || ticket.SessionId != claim.SessionId
                || !string.Equals(ticket.AgentSlug, agentSlug, StringComparison.Ordinal))
            {
                // Adulterado, vencido, de outra sessão ou de outro agente: não é prova de nada. A pessoa do bilhete (se houver) nem é consultada.
                LogRefused();
                close.Add((new PcRtcSession(claim.SessionId, ticket?.UserId ?? Guid.Empty, agent.AgentId, agentSlug, now), PcRtcCloseV1BodyReason.Revoked));
                continue;
            }

            var claimed = new PcRtcSession(
                ticket.SessionId, ticket.UserId, agent.AgentId, agentSlug, ticket.IssuedAt < now ? ticket.IssuedAt : now, ticket.Family, false, ticket.Scopes, ticket.TvId);
            var restore = sessions.Restore(claimed);
            if (restore.Outcome is PcRtcRestoreOutcome.Closed or PcRtcRestoreOutcome.Replaced)
            {
                close.Add((claimed, restore.Outcome == PcRtcRestoreOutcome.Closed ? PcRtcCloseV1BodyReason.Revoked : PcRtcCloseV1BodyReason.Replaced));
                continue;
            }

            // Já no registro (a revogação que chegar agora a encontra), confere de novo, com a regra da oferta.
            var session = restore.Session!;
            var valid = PcRtcScopes.None;
            if (ticket.Family is { } family && await families.IsActiveAsync(session.UserId, family, cancellationToken))
            {
                valid = await authority.ValidScopesAsync(session.UserId, session.Scopes, session.TvId, agentSlug, cancellationToken);
                // O aparelho que o dono do PC recusou (ou ainda não aprovou) não leva o PC, como na oferta.
                if (valid.HasFlag(PcRtcScopes.Pc) && ticket.DeviceId is not null && deviceStates.RefusalFor(agentSlug, ticket.DeviceId) is not null)
                {
                    valid &= ~PcRtcScopes.Pc;
                }
            }

            if (CloseReasonFor(session.Scopes, valid) is { } reason)
            {
                close.Add((session, reason));
            }
            else
            {
                kept.Add(session);
            }
        }

        if (close.Count > 0)
        {
            await closer.CloseAsync(close, cancellationToken);
        }

        // As conferências têm awaits: uma revogação pode ter tirado a sessão (ou a marcado) desde que ela foi reconstruída. Só se confirma o que
        // AINDA está lá e limpo, conferido sob o trinco do registro imediatamente antes de cada confirmação.
        var confirmed = 0;
        var late = new List<(PcRtcSession Session, PcRtcCloseV1BodyReason Reason)>();
        foreach (var session in kept)
        {
            if (!sessions.IsLiveAndClean(session.Id, session.UserId))
            {
                late.Add((session, PcRtcCloseV1BodyReason.Revoked));
                continue;
            }

            await gateway.SendAsync(agentSlug, PcMessages.RtcReconciled(session.Id), cancellationToken);
            confirmed++;
        }

        if (late.Count > 0)
        {
            await closer.CloseAsync(late, cancellationToken);
        }

        LogReconciled(confirmed, close.Count + late.Count);
    }

    /// <summary>
    /// O que fazer com um canal que pedia <paramref name="scopes"/> e agora só tem direito a <paramref name="valid"/>: nada (nulo, tudo de pé),
    /// <c>rescoped</c> (sobrou um escopo, e o app abre outro com ele) ou <c>revoked</c> (nada sobrou). A mesma regra do ouvinte de acesso.
    /// </summary>
    internal static PcRtcCloseV1BodyReason? CloseReasonFor(PcRtcScopes scopes, PcRtcScopes valid) =>
        (valid & scopes) == scopes
            ? null
            : (valid & scopes) == PcRtcScopes.None ? PcRtcCloseV1BodyReason.Revoked : PcRtcCloseV1BodyReason.Rescoped;

    [LoggerMessage(Level = LogLevel.Information, Message = "Canais diretos reconciliados depois da reconexão do agente: {Confirmed} confirmados, {Closed} fechados.")]
    private partial void LogReconciled(int confirmed, int closed);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Reconciliação do canal direto ignorada: a conexão do agente não declarou pc.rtc.reconcile.v1.")]
    private partial void LogIgnored();

    [LoggerMessage(Level = LogLevel.Warning, Message = "Reconciliação do canal direto recusada: bilhete adulterado, vencido, de outra sessão ou de outro agente.")]
    private partial void LogRefused();
}

internal static class PcRtcEndpoints
{
    /// <summary>
    /// O canal direto é do aparelho, não só do PC: quem tem o controle do PC (<c>module:pc</c>) ou o da TV (<c>tv:control</c>) pode
    /// abri-lo. O que ele leva é decidido na oferta, escopo a escopo (ver <see cref="PcRtcHandler"/>), e a rota nunca concede o que a
    /// permissão da pessoa não cobre. O caminho `/pc/rtc` é o do primeiro uso do canal e se mantém: o app e o agente já o conhecem.
    /// </summary>
    public const string Policy = "devices:direct-channel";

    public static void ConfigurePolicy(AuthorizationPolicyBuilder policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        policy.RequireAnyPermission(AccessPermissions.PcModule, AccessPermissions.TvControl);
    }

    private static readonly string ModulePolicy = Policy;

    /// <summary>
    /// A rota do uso do canal não pede permissão de módulo: para um convidado, conferir a permissão lê o banco quando o cache esfria, e o
    /// app manda o uso a cada minuto. Quem autoriza é a sessão do canal, em memória, que a oferta já autorizou: ela existe, é da mesma
    /// conta do token e não venceu (ver <see cref="PcRtcSessions.AcceptsUsage"/>). O papel (dono ou convidado) vem da claim do token,
    /// também sem banco.
    /// </summary>
    public const string UsagePolicy = "devices:direct-channel-usage";

    public static void ConfigureUsagePolicy(AuthorizationPolicyBuilder policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        policy.RequireAccountRole(AccountRoles.Owner, AccountRoles.Guest).AddRequirements(new PcRtcUsageRequirement());
    }

    /// <summary>Mapeia as rotas do canal direto em <c>/api/v1/pc/rtc</c>. Todas pedem <c>module:pc</c> ou <c>tv:control</c> e o balde de limite próprio.</summary>
    public static void MapPcRtc(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var group = endpoints.MapGroup("/api/v1/pc/rtc");

        group.MapPost("/offer", OfferAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcRtc)
            .Produces<PcRtcOfferResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

        group.MapPost("/{sessionId:guid}/candidates", CandidateAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcRtc)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status410Gone)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable);

        // O uso do canal (só a contagem de segundos, nada do que foi digitado): memória só, sem banco e sem o agente.
        group.MapPost("/{sessionId:guid}/usage", Usage)
            .RequireAuthorization(UsagePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcRtc)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

        group.MapPost("/{sessionId:guid}/close", CloseAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcRtc)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);
    }

    private static async Task<IResult> OfferAsync(
        PcRtcOfferRequest? request,
        ICurrentUser current,
        HttpContext http,
        PcRtcHandler handler,
        TimeProvider time,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        var errors = PcRtcValidator.Offer(request);
        return errors.Count > 0
            ? ProblemDetailsExtensions.ValidationProblem(errors)
            : await handler.OfferAsync(
                userId,
                string.Equals(AccountRoles.Of(http.User), AccountRoles.Owner, StringComparison.Ordinal),
                current.SessionId,
                RemainingAccess(http.User, time),
                request!,
                ClientInfo.From(http),
                cancellationToken);
    }

    /// <summary>O que resta do token de acesso (claim <c>exp</c>); sem a claim, o teto.</summary>
    internal static TimeSpan RemainingAccess(ClaimsPrincipal user, TimeProvider time)
    {
        var claim = user.FindFirst("exp")?.Value;
        return long.TryParse(claim, NumberStyles.None, CultureInfo.InvariantCulture, out var expires)
            ? DateTimeOffset.FromUnixTimeSeconds(expires) - time.GetUtcNow()
            : PcRtcHandler.MaxLifetime;
    }

    private static async Task<IResult> CandidateAsync(
        Guid sessionId, PcRtcCandidateRequest? request, ICurrentUser current, PcRtcHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        var errors = PcRtcValidator.Candidate(request);
        return errors.Count > 0
            ? ProblemDetailsExtensions.ValidationProblem(errors)
            : await handler.CandidateAsync(userId, sessionId, request!, cancellationToken);
    }

    private static async Task<IResult> CloseAsync(
        Guid sessionId, ICurrentUser current, HttpContext http, PcRtcHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        return await handler.CloseAsync(userId, sessionId, ClientInfo.From(http), cancellationToken);
    }

    /// <summary>
    /// O app conta os segundos em que mandou tecla ou mouse pelo canal (a API não os vê: o canal é direto) e manda aqui o TOTAL da
    /// sessão a cada minuto e ao fechar. Repetir o total não soma de novo, e o aceito nunca passa do tempo que o canal está aberto. A política só deixa passar a sessão da própria pessoa, viva ou fechada há pouco (a última contagem chega depois do
    /// fechamento).
    /// </summary>
    private static IResult Usage(
        Guid sessionId, PcRtcUsageRequest? request, ICurrentUser current, PcRtcSessions sessions, AgentParity parity)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        if (request?.TotalSeconds is not { } total || total < 1 || total > PcRtcSessions.MaxUsageTotalSeconds)
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["totalSeconds"] = [$"Mande o total de 1 a {PcRtcSessions.MaxUsageTotalSeconds} segundos."],
            });
        }

        // A política já conferiu a sessão; ela pode ter saído da memória entre a política e aqui.
        if (sessions.RecordUsage(sessionId, userId, total) is not { } usage)
        {
            return TypedResults.NotFound();
        }

        parity.OnDirectUse(usage.AgentSlug, usage.Added);
        return TypedResults.NoContent();
    }
}

/// <summary>A sessão do canal na rota do uso pode receber o uso de quem pede (ver <see cref="PcRtcEndpoints.UsagePolicy"/>).</summary>
internal sealed class PcRtcUsageRequirement : IAuthorizationRequirement
{
}

/// <summary>Autoriza o uso do canal só pela memória: a sessão da rota, viva ou fechada há pouco, é desta conta. Nenhuma consulta.</summary>
internal sealed class PcRtcUsageAuthorizer(PcRtcSessions sessions) : AuthorizationHandler<PcRtcUsageRequirement>
{
    protected override Task HandleRequirementAsync(AuthorizationHandlerContext context, PcRtcUsageRequirement requirement)
    {
        if (context.Resource is HttpContext http
            && Guid.TryParse(http.GetRouteValue("sessionId") as string, out var sessionId)
            && Guid.TryParse(context.User.FindFirst(UniOverAuth.SubjectClaim)?.Value, out var userId)
            && sessions.AcceptsUsage(sessionId, userId))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}
