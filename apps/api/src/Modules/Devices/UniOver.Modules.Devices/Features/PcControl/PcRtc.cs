using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Http;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Features.RemoteCare;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;
using UniOver.Modules.Tv.Contracts;

namespace UniOver.Modules.Devices.Features.PcControl;

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
    TimeProvider? time = null,
    PcScreenFlag? screenFlag = null)
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

    private static readonly TimeSpan ScreenMaxLifetime = TimeSpan.FromSeconds(90);

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
        var isScreen = requested == PcRtcScopes.Screen;
        // A tela só abre com a flag ligada, para o dono e com a permissão própria (pc:screen, além de module:pc, conferida mais abaixo).
        if (requested.HasFlag(PcRtcScopes.Screen) && (!isScreen || !isOwner || sessionFamily is null
            || request.ParentSessionId is null || request.ParentSessionId == Guid.Empty
            || screenFlag?.Enabled != true
            || !await grants.HasAsync(userId, AccessPermissions.PcScreen, cancellationToken)))
        {
            return PcProblems.DirectForbidden();
        }

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
        if ((requested.HasFlag(PcRtcScopes.Pc) || isScreen) && await grants.HasAsync(userId, AccessPermissions.PcModule, cancellationToken))
        {
            allowed = true;
            var pc = await resolver.ResolveAsync(userId, cancellationToken);
            if (pc is not null && (target is null || string.Equals(pc.Slug, target.Slug, StringComparison.Ordinal)))
            {
                target = pc;
                granted |= isScreen ? PcRtcScopes.Screen : PcRtcScopes.Pc;
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

        if (!OffersDirect(target) || isScreen && !target.Capabilities.Contains(PcMessages.ScreenRtcCapability, StringComparer.Ordinal))
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
        var withPc = granted.HasFlag(PcRtcScopes.Pc) || isScreen;
        if (isScreen && (origin.DeviceId is null || !target.Capabilities.Contains(PcMessages.DeviceCapability, StringComparer.Ordinal)))
        {
            return PcProblems.DirectForbidden();
        }
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
        // Para a tela, a API confere a sessão de login e o agente confirma que o controle pai foi autenticado por este aparelho.
        var session = isScreen
            ? sessions.TryOpenScreen(userId, target.AgentId, target.Slug, sessionFamily, request.ParentSessionId!.Value, out var previous)
            : sessions.TryOpen(userId, isOwner, target.AgentId, target.Slug, sessionFamily, granted, tvId, out previous);
        if (session is null)
        {
            return isScreen ? PcProblems.DirectForbidden() : PcProblems.DirectBusy();
        }

        var token = NewToken();
        using var pending = answers.Expect(target.Slug, session.Id);
        var maxLifetime = (int)Math.Min(lifetime.TotalSeconds, (isScreen ? ScreenMaxLifetime : MaxLifetime).TotalSeconds);
        // Sem o escopo da TV a oferta é a de sempre (sem o campo): é a única que um agente anterior entende.
        var scopes = granted == PcRtcScopes.Pc ? null : PcRtcScopeNames.ToWire(granted);
        // Quem sabe reconciliar (reconectar depois de a API reiniciar) leva um bilhete assinado pela API, que o agente só guarda e devolve; o
        // esquema da oferta de um agente anterior é fechado, então o campo nem sai para ele. Sem a sessão de login não há bilhete (a API
        // não teria como saber se ela ainda vale): o canal, se sobreviver a uma reinicialização, é reaberto pelo app.
        var reconcilable = !isScreen && tickets is not null
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
            ticket,
            session.ParentSessionId);

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
            if (!isScreen && reply.Value.Error?.Code != RtcClosedCode)
            {
                await ReplacePreviousAsync(previous, target.Slug, client, cancellationToken);
            }

            return reply.Value.Error?.Code == RtcClosedCode
                ? PcProblems.DirectRevoked()
                : RemoteCareProblems.CommandFailed(reply.Value.Error?.Code);
        }

        // O agente aceitou a oferta: agora sim as anteriores do mesmo tipo saem do registro, com o aviso e a trilha.
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
            if (isScreen)
            {
                await CloseWithoutRequestAsync(target.Slug, session.Id);
            }

            return RemoteCareProblems.Timeout();
        }

        // A negociação leva segundos, e a sessão pode ter sido revogada nesse meio (o ouvinte a tirou daqui e mandou o fechamento,
        // que pode ter passado na frente da oferta no agente): nada do canal chega ao app, e o agente é avisado outra vez.
        if (!sessions.FinishNegotiation(session.Id, userId, issuedAt + TimeSpan.FromSeconds(maxLifetime)))
        {
            if (isScreen)
            {
                sessions.TakeOwned(session.Id, userId);
            }

            await CloseWithoutRequestAsync(target.Slug, session.Id);
            return PcProblems.DirectRevoked();
        }

        // A trilha diz que o canal foi negociado e entregue (ele só abre depois, direto entre o app e o PC) e nunca leva SDP nem token.
        audit.Add(isScreen ? PairingEvents.PcScreenOpened : PairingEvents.PcDirectOpened, client, agentId: target.AgentId, userId: userId);
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
            audit.Add(PcRtcAudit.ClosedEvent(old), client, agentId: old.AgentId, userId: old.UserId);
            // Grava já: o fechamento do canal anterior não pode se perder se algo falhar adiante.
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    public async Task<IResult> CandidateAsync(
        Guid userId, Guid sessionId, PcRtcCandidateRequest request, CancellationToken cancellationToken, Guid? sessionFamily = null)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (sessions.Get(sessionId, userId, negotiating: true, sessionFamily) is not { } session)
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
    public async Task<IResult> CloseAsync(Guid userId, Guid sessionId, ClientInfo client, CancellationToken cancellationToken, Guid? sessionFamily = null)
    {
        if (sessions.TakeOwned(sessionId, userId, sessionFamily ?? Guid.Empty) is not { } session)
        {
            return TypedResults.NotFound();
        }

        // Falhar o aviso (o PC caiu) não impede o registro: o canal já morreu junto com a conexão do agente.
        await gateway.SendAsync(session.AgentSlug, PcMessages.RtcClose(sessionId, PcRtcCloseV1BodyReason.Requested), cancellationToken);
        audit.Add(PcRtcAudit.ClosedEvent(session), client, agentId: session.AgentId, userId: userId);
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
