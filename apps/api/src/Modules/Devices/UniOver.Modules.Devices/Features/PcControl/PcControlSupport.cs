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
/// presença é lida a cada pedido: a lista acompanha uma atualização do agente sem esperar nada).
/// </summary>
internal sealed record PcTarget(Guid AgentId, string Slug, bool Connected, IReadOnlyList<string> Capabilities);

/// <summary>Um agente ativo com a capacidade do controle do PC, como o resolvedor o vê.</summary>
internal sealed record PcCandidate(
    Guid AgentId, string Slug, Guid PairedBy, DateTimeOffset CreatedAt, bool Connected, IReadOnlyList<string> Capabilities);

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
            .Select(x => new PcCandidate(x.Agent.Id, x.Agent.Slug, x.Agent.PairedBy, x.Agent.CreatedAt, x.Info!.Connected, x.Info.Capabilities));

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
        return chosen is null ? null : new PcTarget(chosen.AgentId, chosen.Slug, chosen.Connected, chosen.Capabilities);
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

/// <summary>Guarda a lista de favoritos que o agente anuncia (<c>pc.apps.v1</c>), na ordem em que ele a mandou.</summary>
internal sealed class PcAgentMessageHandler(PcAppsStore store) : IAgentMessageHandler
{
    public IReadOnlyCollection<string> HandledTypes { get; } = [AgentMessageTypes.PcAppsV1];

    public Task HandleAsync(InboundMessage message, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(message);

        // O gateway já validou a mensagem contra o contrato: os campos existem e têm o tipo certo.
        var apps = message.Body.GetProperty("apps").EnumerateArray()
            .Select(a => new PcApp(a.GetProperty("id").GetString()!, a.GetProperty("label").GetString()!))
            .ToList();
        store.Set(message.AgentId, apps);
        return Task.CompletedTask;
    }
}
