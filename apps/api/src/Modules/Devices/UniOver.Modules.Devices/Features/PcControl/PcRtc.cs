using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Domain;
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

    private readonly object _gate = new();
    private readonly Dictionary<Guid, PcRtcSession> _sessions = [];
    private readonly Dictionary<Guid, (PcRtcSession Session, DateTimeOffset Until)> _closedTv = [];

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
        if (session.TvId is not null)
        {
            _closedTv[session.Id] = (session, time.GetUtcNow() + ClosedTvMemory);
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
    public void MarkRevokePending(Guid sessionId)
    {
        lock (_gate)
        {
            if (_sessions.TryGetValue(sessionId, out var session))
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
    ITvDirectChannels? tv = null)
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
            return PcProblems.DeviceRefused(refusal);
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
        var message = PcMessages.RtcOffer(session.Id, request.Sdp!, token, (int)PcRtcSessions.TokenLifetime.TotalSeconds, maxLifetime, scopes);

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
    ILogger<PcRtcRevoker> logger)
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
                    sessions.MarkRevokePending(session.Id);
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
}
