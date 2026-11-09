using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Features.RemoteCare;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;
using UniOver.Modules.Identity.Contracts;

namespace UniOver.Modules.Devices.Features.PcControl;

internal sealed record PcRtcOfferRequest(string? Sdp);

internal sealed record PcRtcCandidateRequest(string? Candidate, string? SdpMid, int? SdpMLineIndex);

/// <summary>A resposta da oferta: o SDP do agente (com a impressão digital DTLS dele) e o token que a primeira mensagem do canal apresenta.</summary>
internal sealed record PcRtcOfferResponse(Guid SessionId, string Sdp, string Token, int ExpiresInSeconds);

/// <summary>Uma sessão do canal direto, como a API a conhece: de quem é, de qual PC, e quando a negociação começou.</summary>
/// <param name="SessionFamily">A sessão (família do refresh) que abriu o canal: ela acabando, o canal fecha junto.</param>
internal sealed record PcRtcSession(
    Guid Id, Guid UserId, Guid AgentId, string AgentSlug, DateTimeOffset OpenedAt, Guid? SessionFamily = null);

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

    private readonly object _gate = new();
    private readonly Dictionary<Guid, PcRtcSession> _sessions = [];

    public PcRtcSession Open(Guid userId, Guid agentId, string agentSlug, Guid? sessionFamily = null)
    {
        var now = time.GetUtcNow();
        var session = new PcRtcSession(Guid.CreateVersion7(), userId, agentId, agentSlug, now, sessionFamily);
        lock (_gate)
        {
            foreach (var old in _sessions.Where(s => now - s.Value.OpenedAt > MaxAge).Select(s => s.Key).ToList())
            {
                _sessions.Remove(old);
            }

            _sessions[session.Id] = session;
        }

        return session;
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

            _sessions.Remove(sessionId);
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

            _sessions.Remove(sessionId);
            return session;
        }
    }

    /// <summary>Tira as sessões de uma pessoa que cumprem a condição (a sessão, a senha, a conta ou a permissão dela mudou).</summary>
    public IReadOnlyList<PcRtcSession> TakeWhere(Guid userId, Func<PcRtcSession, bool> match)
    {
        lock (_gate)
        {
            var found = _sessions.Values.Where(s => s.UserId == userId && match(s)).ToList();
            foreach (var session in found)
            {
                _sessions.Remove(session.Id);
            }

            return found;
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
                _sessions.Remove(session.Id);
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
internal sealed class PcRtcClosures(PcRtcSessions sessions, PairingAuditWriter audit, DevicesDbContext db)
{
    public async Task AgentClosedAsync(string agentSlug, Guid sessionId, CancellationToken cancellationToken)
    {
        if (sessions.TakeForAgent(agentSlug, sessionId) is not { } session)
        {
            return;
        }

        audit.Add(PairingEvents.PcDirectClosed, new ClientInfo(null, null), agentId: session.AgentId, userId: session.UserId);
        await db.SaveChangesAsync(cancellationToken);
    }
}

/// <summary>
/// O canal direto (WebRTC) entre o app e o PC. A API só faz o papel de sinalização autenticada: confere que quem pede é a
/// própria pessoa dona do PC (a mesma regra do controle: <see cref="PcAgentResolver"/>), repassa a oferta ao agente pelo canal que
/// já existe, devolve a resposta (com a impressão digital DTLS) e um token de uso único e vida curta, que a primeira mensagem do
/// canal precisa apresentar. Nenhum SDP é guardado nem vai para o registro, e o token só passa daqui para o agente e para o app.
/// </summary>
internal sealed class PcRtcHandler(
    PcAgentResolver resolver,
    IAgentGateway gateway,
    PcRtcSessions sessions,
    PcRtcAnswers answers,
    PairingAuditWriter audit,
    DevicesDbContext db)
{
    /// <summary>O agente carrega a biblioteca na primeira oferta (cerca de um segundo) e junta os candidatos; o prazo dele é de 12 s, e o desta espera é maior para a recusa dele chegar antes.</summary>
    public static readonly TimeSpan OfferTimeout = TimeSpan.FromSeconds(15);

    /// <summary>Depois do resultado do comando a resposta já devia ter chegado (ela sai antes); uma folga curta basta.</summary>
    public static readonly TimeSpan AnswerGrace = TimeSpan.FromSeconds(2);

    /// <summary>A vida máxima de um canal: o que resta do token de acesso da pessoa, entre estes limites.</summary>
    public static readonly TimeSpan MinLifetime = TimeSpan.FromSeconds(60);

    public static readonly TimeSpan MaxLifetime = TimeSpan.FromMinutes(15);

    /// <param name="lifetime">O que resta do token de acesso desta requisição: o canal nunca vive mais que ele.</param>
    /// <param name="sessionFamily">A sessão (família do refresh) da requisição; o canal fecha quando ela acaba.</param>
    public async Task<IResult> OfferAsync(
        Guid userId,
        Guid? sessionFamily,
        TimeSpan lifetime,
        PcRtcOfferRequest request,
        ClientInfo client,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var target = await resolver.ResolveAsync(userId, cancellationToken);
        if (target is null)
        {
            return PcProblems.Unavailable();
        }

        if (!target.Connected)
        {
            return RemoteCareProblems.Offline();
        }

        if (!OffersDirect(target))
        {
            return PcProblems.DirectUnavailable();
        }

        // No máximo um canal por PC: a oferta nova substitui a anterior (o agente também troca o par e solta o que segurava).
        foreach (var old in sessions.TakeAllForAgent(target.Slug))
        {
            await gateway.SendAsync(target.Slug, PcMessages.RtcClose(old.Id, PcRtcCloseV1BodyReason.Replaced), cancellationToken);
            audit.Add(PairingEvents.PcDirectClosed, client, agentId: old.AgentId, userId: old.UserId);
            // Grava já: se a oferta nova falhar adiante, o fechamento do canal anterior não pode se perder.
            await db.SaveChangesAsync(cancellationToken);
        }

        var session = sessions.Open(userId, target.AgentId, target.Slug, sessionFamily);
        var token = NewToken();
        using var pending = answers.Expect(target.Slug, session.Id);
        var maxLifetime = (int)Math.Clamp(lifetime.TotalSeconds, MinLifetime.TotalSeconds, MaxLifetime.TotalSeconds);
        var message = PcMessages.RtcOffer(session.Id, request.Sdp!, token, (int)PcRtcSessions.TokenLifetime.TotalSeconds, maxLifetime);

        var reply = await gateway.RequestAsync(target.Slug, message, OfferTimeout, cancellationToken);
        if (reply.IsFailure)
        {
            sessions.TakeOwned(session.Id, userId);
            return PcProblems.FromGateway(reply.Error);
        }

        if (!reply.Value.Ok)
        {
            sessions.TakeOwned(session.Id, userId);
            return RemoteCareProblems.CommandFailed(reply.Value.Error?.Code);
        }

        var answer = await pending.WaitAsync(AnswerGrace, cancellationToken);
        if (answer is null)
        {
            sessions.TakeOwned(session.Id, userId);
            return RemoteCareProblems.Timeout();
        }

        // A trilha diz que o canal foi negociado e entregue (ele só abre depois, direto entre o app e o PC) e nunca leva SDP nem token.
        audit.Add(PairingEvents.PcDirectOpened, client, agentId: target.AgentId, userId: userId);
        await db.SaveChangesAsync(cancellationToken);
        return TypedResults.Ok(new PcRtcOfferResponse(session.Id, answer, token, (int)PcRtcSessions.TokenLifetime.TotalSeconds));
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

    /// <summary>O PC declarou o canal direto no <c>hello</c> desta sessão (um agente "esperado de volta" não conta: guarda as de antes).</summary>
    private static bool OffersDirect(PcTarget target) =>
        target.HelloAt is not null && target.Capabilities.Contains(PcMessages.RtcCapability, StringComparer.Ordinal);

    /// <summary>32 bytes aleatórios em base64url sem preenchimento: 43 caracteres.</summary>
    private static string NewToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

/// <summary>
/// O canal direto não passa pela API a cada comando, então não perceberia sozinho que a pessoa deixou de poder usá-lo. Aqui ele
/// fecha na hora quando a sessão que o abriu acaba (sair, "sair de todos", senha trocada ou recuperada, aparelho revogado), a
/// conta é pausada ou revogada, ou a permissão do módulo é retirada: o agente solta o que o PC segurava, e a trilha grava o
/// fechamento. Em processo, como os caches de permissão do Identity; um canal de outra instância vale em até a vida máxima dele.
/// </summary>
internal sealed class PcRtcAccessListener(
    PcRtcSessions sessions, IAgentGateway gateway, PairingAuditWriter audit, DevicesDbContext db) : IUserAccessListener
{
    public async Task ChangedAsync(UserAccessChange change, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(change);

        var closing = sessions.TakeWhere(change.UserId, session => Affects(change, session));
        foreach (var session in closing)
        {
            await gateway.SendAsync(session.AgentSlug, PcMessages.RtcClose(session.Id, PcRtcCloseV1BodyReason.Revoked), cancellationToken);
            audit.Add(PairingEvents.PcDirectClosed, new ClientInfo(null, null), agentId: session.AgentId, userId: session.UserId);
        }

        if (closing.Count > 0)
        {
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    private static bool Affects(UserAccessChange change, PcRtcSession session) => change.Kind switch
    {
        UserAccessChangeKind.SessionEnded => session.SessionFamily == change.SessionId,
        UserAccessChangeKind.SessionsEnded => change.SessionId is null || session.SessionFamily != change.SessionId,
        UserAccessChangeKind.AccountDisabled => true,
        UserAccessChangeKind.ModuleRemoved => string.Equals(change.Module, AccessPermissions.PcModule, StringComparison.Ordinal),
        _ => false,
    };
}

internal static class PcRtcEndpoints
{
    private static readonly string ModulePolicy = AccessPermissions.Policy(AccessPermissions.PcModule);

    /// <summary>Mapeia as rotas do canal direto em <c>/api/v1/pc/rtc</c>. Todas pedem <c>module:pc</c> e o balde de limite próprio.</summary>
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
                userId, current.SessionId, RemainingAccess(http.User, time), request!, ClientInfo.From(http), cancellationToken);
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
