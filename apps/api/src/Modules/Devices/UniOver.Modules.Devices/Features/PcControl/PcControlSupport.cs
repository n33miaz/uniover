using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Contracts.Pairing;
using UniOver.Modules.Devices.Features.RemoteCare;
using UniOver.Modules.Devices.Persistence;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>Um favorito que o PC deixa abrir: só o identificador e o nome (o caminho nunca sai do PC).</summary>
internal sealed record PcApp(string Id, string Label);

/// <summary>
/// Os favoritos que cada agente anunciou no <c>pc.apps.v1</c>. Em memória e da instância (nada estático): o agente
/// os manda de novo a cada conexão, então reiniciar a API não perde nada que não volte sozinho.
/// </summary>
internal sealed class PcAppsStore
{
    private readonly object _gate = new();
    private readonly Dictionary<string, IReadOnlyList<PcApp>> _apps = new(StringComparer.Ordinal);

    public void Set(string agentSlug, IReadOnlyList<PcApp> apps)
    {
        lock (_gate)
        {
            _apps[agentSlug] = apps;
        }
    }

    public IReadOnlyList<PcApp> Get(string agentSlug)
    {
        lock (_gate)
        {
            return _apps.GetValueOrDefault(agentSlug) ?? [];
        }
    }
}

/// <summary>
/// O computador que atende o pedido: o agente, se está conectado agora e o que ele declarou no último <c>hello</c> (a
/// presença é lida a cada pedido: a lista acompanha uma atualização do agente sem esperar nada). <c>HelloAt</c> é quando
/// chegou o <c>hello</c> da sessão de agora; nulo = as capacidades não são desta sessão (agente "esperado de volta" depois de
/// uma queda ou de a API reiniciar guarda as de antes), e nada se decide por elas.
/// </summary>
internal sealed record PcTarget(
    Guid AgentId, string Slug, bool Connected, IReadOnlyList<string> Capabilities, DateTimeOffset? HelloAt);

/// <summary>Um agente ativo com a capacidade do controle do PC, como o resolvedor o vê.</summary>
internal sealed record PcCandidate(
    Guid AgentId,
    string Slug,
    Guid PairedBy,
    DateTimeOffset CreatedAt,
    bool Connected,
    IReadOnlyList<string> Capabilities,
    DateTimeOffset? HelloAt = null);

/// <summary>Um agente ativo de uma pessoa, como o banco o devolve (a presença nunca entra aqui: é lida a cada pedido).</summary>
internal sealed record PcAgentRow(Guid Id, string Slug, Guid PairedBy, DateTimeOffset CreatedAt);

/// <summary>
/// Guarda por poucos segundos a lista dos agentes ativos de cada pessoa, a única leitura de banco do caminho do movimento
/// do mouse (uns 30 pedidos por segundo). Só as linhas do banco ficam aqui: se o PC está conectado e se declarou o controle
/// continua vindo da presença, ao vivo, a cada pedido. Lista vazia nunca é guardada (um PC recém-pareado aparece na hora)
/// e a revogação de um agente esquece tudo (<see cref="PcAgentRevokedInvalidator"/>); mesmo sem isso, um agente revogado
/// perde a sessão e a presença, então o pedido falharia como "desconectado". Em memória e da instância.
/// </summary>
internal sealed class PcTargetCache(TimeProvider time)
{
    /// <summary>Curto de propósito: o ganho vem de muitos pedidos seguidos, não de guardar por muito tempo.</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromSeconds(5);

    private readonly Dictionary<Guid, (IReadOnlyList<PcAgentRow> Rows, DateTimeOffset Expires)> _entries = [];
    private readonly object _gate = new();

    public bool TryGet(Guid userId, out IReadOnlyList<PcAgentRow> rows)
    {
        lock (_gate)
        {
            if (_entries.TryGetValue(userId, out var entry) && entry.Expires > time.GetUtcNow())
            {
                rows = entry.Rows;
                return true;
            }
        }

        rows = [];
        return false;
    }

    public void Set(Guid userId, IReadOnlyList<PcAgentRow> rows)
    {
        if (rows.Count == 0)
        {
            return;
        }

        lock (_gate)
        {
            // Poda o que já venceu: o dicionário nunca passa de umas poucas contas.
            var now = time.GetUtcNow();
            foreach (var expired in _entries.Where(e => e.Value.Expires <= now).Select(e => e.Key).ToList())
            {
                _entries.Remove(expired);
            }

            _entries[userId] = (rows, now + Lifetime);
        }
    }

    public void Clear()
    {
        lock (_gate)
        {
            _entries.Clear();
        }
    }
}

/// <summary>Esquece a lista guardada quando um agente é revogado: o próximo pedido lê o banco.</summary>
internal sealed class PcAgentRevokedInvalidator(PcTargetCache cache) : IIntegrationEventHandler<AgentRevoked>
{
    public Task HandleAsync(AgentRevoked integrationEvent, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(integrationEvent);
        cache.Clear();
        return Task.CompletedTask;
    }
}

/// <summary>
/// Qual computador o controle do PC usa. Só conta agente ativo que declarou <c>pc.control.v1</c> (a pessoa ligou o controle
/// naquele PC) E que foi pareado pela própria pessoa. Nunca há reserva no PC de outra pessoa, nem do dono para o
/// convidado, nem de um convidado para o dono, nem de um convidado para outro: conceder <c>module:pc</c> libera a tela, não
/// o computador de ninguém. Quem não tem PC próprio com o controle ligado recebe "nenhum PC". Com vários próprios, o
/// conectado vence, e depois o mais antigo.
/// </summary>
internal sealed class PcAgentResolver(DevicesDbContext db, IAgentPresenceReader presence, PcTargetCache cache)
{
    public async Task<PcTarget?> ResolveAsync(Guid userId, CancellationToken cancellationToken)
    {
        if (!cache.TryGet(userId, out var agents))
        {
            agents = await db.Agents.AsNoTracking()
                .Where(a => a.RevokedAt == null && a.PairedBy == userId)
                .Select(a => new PcAgentRow(a.Id, a.Slug, a.PairedBy, a.CreatedAt))
                .ToListAsync(cancellationToken);
            cache.Set(userId, agents);
        }

        var candidates = agents
            .Select(a => (Agent: a, Info: presence.Get(a.Slug)))
            .Where(x => x.Info is not null && x.Info.Capabilities.Contains(PcMessages.Capability, StringComparer.Ordinal))
            .Select(x => new PcCandidate(x.Agent.Id, x.Agent.Slug, x.Agent.PairedBy, x.Agent.CreatedAt, x.Info!.Connected, x.Info.Capabilities,
                // Só vale o `hello` de uma sessão viva: quem está "esperado de volta" ainda não mandou o desta conexão.
                x.Info.Connected && x.Info.ConnectedSince is not null ? x.Info.HelloAt : null));

        return Choose(candidates, userId);
    }

    /// <summary>A regra pura: só os agentes da própria pessoa; o conectado primeiro e, entre iguais, o mais antigo.</summary>
    public static PcTarget? Choose(IEnumerable<PcCandidate> candidates, Guid userId)
    {
        ArgumentNullException.ThrowIfNull(candidates);

        var chosen = candidates
            .Where(c => c.PairedBy == userId)
            .OrderByDescending(c => c.Connected)
            .ThenBy(c => c.CreatedAt)
            .FirstOrDefault();
        return chosen is null ? null : new PcTarget(chosen.AgentId, chosen.Slug, chosen.Connected, chosen.Capabilities, chosen.HelloAt);
    }
}

/// <summary>Respostas de erro do controle do PC, com os <c>type</c> estáveis que a tela reconhece.</summary>
internal static class PcProblems
{
    public const string UnavailableType = "pc-unavailable";

    /// <summary>Nenhum computador tem o controle do PC ligado: a tela explica como ligar.</summary>
    public static IResult Unavailable() => Results.Problem(
        statusCode: StatusCodes.Status409Conflict,
        title: "Nenhum computador está com o controle do PC ligado.",
        type: ProblemDetailsExtensions.TypeBase + UnavailableType);

    public const string KeyUnsupportedType = "pc-key-unsupported";

    /// <summary>
    /// O pedido de tecla precisa da <c>pc.key.v2</c> (repetição, segurar modificador, tecla nova) e o agente deste PC é de antes
    /// dela: nada é enviado (o esquema fechado dele recusaria a mensagem e o toque morreria sem explicação). A tela mostra
    /// "atualize o agente do PC".
    /// </summary>
    public static IResult KeyUnsupported() => Results.Problem(
        statusCode: StatusCodes.Status409Conflict,
        title: "O agente deste PC é antigo demais para esta tecla. Atualize o agente do PC.",
        type: ProblemDetailsExtensions.TypeBase + KeyUnsupportedType);

    /// <summary>
    /// As repetições de teclas num minuto passaram do teto da conta: <c>repeat</c> conta cada aperto, e não um por pedido.
    /// Soltar um modificador nunca entra na conta.
    /// </summary>
    public static IResult KeyBudgetExceeded() => Results.Problem(
        statusCode: StatusCodes.Status429TooManyRequests,
        title: "Muitas teclas seguidas. Espere um instante.",
        type: ProblemDetailsExtensions.TypeBase + ProblemDetailsExtensions.RateLimited);

    public const string DirectUnavailableType = "pc-direct-unavailable";

    /// <summary>O PC não declara o canal direto (agente anterior, ou a biblioteca não está instalada): o app segue pela nuvem.</summary>
    public static IResult DirectUnavailable() => Results.Problem(
        statusCode: StatusCodes.Status409Conflict,
        title: "Este computador não oferece o canal direto.",
        type: ProblemDetailsExtensions.TypeBase + DirectUnavailableType);

    public const string DirectExpiredType = "pc-direct-expired";

    /// <summary>A sessão do canal direto não existe mais (venceu a janela de negociação, ou nunca foi desta pessoa).</summary>
    public static IResult DirectExpired() => Results.Problem(
        statusCode: StatusCodes.Status410Gone,
        title: "A sessão do canal direto acabou.",
        type: ProblemDetailsExtensions.TypeBase + DirectExpiredType);

    public const string DirectRevokedType = "pc-direct-revoked";

    /// <summary>A pessoa perdeu o acesso (sessão encerrada, senha trocada, permissão retirada) enquanto o canal era negociado: nada dele vale.</summary>
    public static IResult DirectRevoked() => Results.Problem(
        statusCode: StatusCodes.Status409Conflict,
        title: "O acesso mudou enquanto o canal direto abria. Entre de novo.",
        type: ProblemDetailsExtensions.TypeBase + DirectRevokedType);

    public const string ReconnectingType = "agent-reconnecting";

    /// <summary>
    /// O PC aparece conectado (a presença segue verde na graça depois de uma queda) mas não há sessão viva agora: o comando não
    /// foi enviado nem será entregue depois. A tela mostra "reconectando", e não "desconectado".
    /// </summary>
    public static IResult Reconnecting() => Results.Problem(
        statusCode: StatusCodes.Status503ServiceUnavailable,
        title: "O PC está reconectando. Tente de novo em instantes.",
        type: ProblemDetailsExtensions.TypeBase + ReconnectingType);

    /// <summary>
    /// Falha de entrega do gateway como resposta HTTP. Só se chega aqui com o PC mostrado como conectado (sem isso o pedido já
    /// voltou como "desconectado"), então "sem sessão" é a queda que ainda está na graça: reconectando.
    /// </summary>
    public static IResult FromGateway(UniOver.SharedKernel.Error error)
    {
        ArgumentNullException.ThrowIfNull(error);
        return error.Code == AgentErrors.OfflineCode ? Reconnecting() : RemoteCareProblems.FromGateway(error);
    }
}

/// <summary>
/// O teto de apertos de tecla por conta num minuto, contando cada repetição de <c>repeat</c> (o limite de pedidos por minuto
/// do <c>pc-input</c> conta um por pedido, e um pedido pode apertar 50 vezes). Janela fixa, em memória e da instância (como
/// o limite de pedidos). Só quem aperta paga; soltar um modificador não entra aqui.
/// </summary>
internal sealed class PcKeyBudget(TimeProvider time)
{
    /// <summary>100 apertos por segundo: o dobro do que uma tecla segurada faz, com folga para dois aparelhos.</summary>
    public const int PressesPerMinute = 6000;

    private static readonly TimeSpan Window = TimeSpan.FromMinutes(1);
    private readonly object _gate = new();
    private readonly Dictionary<Guid, (DateTimeOffset Start, int Used)> _windows = [];
    private DateTimeOffset _nextSweep = DateTimeOffset.MinValue;

    public bool TryTake(Guid userId, int presses)
    {
        lock (_gate)
        {
            var now = time.GetUtcNow();
            SweepOccasionally(now);

            // Só a janela desta conta é olhada a cada aperto: se venceu, recomeça.
            var (start, used) = _windows.TryGetValue(userId, out var current) && now - current.Start < Window
                ? current
                : (now, 0);
            if (used + presses > PressesPerMinute)
            {
                return false;
            }

            _windows[userId] = (start, used + presses);
            return true;
        }
    }

    /// <summary>
    /// Devolve o que um pedido gastou e não chegou a sair (PC ausente, desconectado, reconectando ou agente antigo): só o
    /// que foi enviado conta. Nunca passa de zero e só mexe na janela de agora.
    /// </summary>
    public void Refund(Guid userId, int presses)
    {
        lock (_gate)
        {
            if (_windows.TryGetValue(userId, out var current) && time.GetUtcNow() - current.Start < Window)
            {
                _windows[userId] = (current.Start, Math.Max(0, current.Used - presses));
            }
        }
    }

    /// <summary>
    /// Uma varredura por minuto, no máximo, tira as contas que não apertam mais nada: o dicionário não cresce com contas
    /// que passaram uma vez, e nenhum aperto paga a varredura inteira.
    /// </summary>
    private void SweepOccasionally(DateTimeOffset now)
    {
        if (now < _nextSweep)
        {
            return;
        }

        _nextSweep = now + Window;
        foreach (var expired in _windows.Where(w => now - w.Value.Start >= Window).Select(w => w.Key).ToList())
        {
            _windows.Remove(expired);
        }
    }
}

/// <summary>Guarda a lista de favoritos que o agente anuncia (<c>pc.apps.v1</c>), na ordem em que ele a mandou.</summary>
internal sealed class PcAgentMessageHandler(PcAppsStore store, PcRtcAnswers answers, PcRtcClosures closures) : IAgentMessageHandler
{
    public IReadOnlyCollection<string> HandledTypes { get; } =
        [AgentMessageTypes.PcAppsV1, AgentMessageTypes.PcRtcAnswerV1, AgentMessageTypes.PcRtcClosedV1];

    public async Task HandleAsync(InboundMessage message, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(message);

        // O canal direto: a resposta à oferta (o SDP só passa por aqui, nunca é guardado) e o aviso de que ele fechou.
        if (string.Equals(message.Type, AgentMessageTypes.PcRtcAnswerV1, StringComparison.Ordinal))
        {
            answers.Complete(message.AgentId, message.Body.GetProperty("sessionId").GetGuid(), message.Body.GetProperty("sdp").GetString()!);
            return;
        }

        if (string.Equals(message.Type, AgentMessageTypes.PcRtcClosedV1, StringComparison.Ordinal))
        {
            await closures.AgentClosedAsync(message.AgentId, message.Body.GetProperty("sessionId").GetGuid(), cancellationToken);
            return;
        }

        // O gateway já validou a mensagem contra o contrato: os campos existem e têm o tipo certo.
        var apps = message.Body.GetProperty("apps").EnumerateArray()
            .Select(a => new PcApp(a.GetProperty("id").GetString()!, a.GetProperty("label").GetString()!))
            .ToList();
        store.Set(message.AgentId, apps);
    }
}
