using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
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

/// <summary>O computador que atende o pedido: o agente, e se está conectado agora.</summary>
internal sealed record PcTarget(Guid AgentId, string Slug, bool Connected);

/// <summary>Um agente ativo com a capacidade do controle do PC, como o resolvedor o vê.</summary>
internal sealed record PcCandidate(Guid AgentId, string Slug, Guid PairedBy, DateTimeOffset CreatedAt, bool Connected);

/// <summary>
/// Qual computador o controle do PC usa. Só conta agente ativo que declarou <c>pc.control.v1</c> (a pessoa ligou o controle
/// naquele PC) E que foi pareado pela própria pessoa. Nunca há reserva no PC de outra pessoa, nem do dono para o
/// convidado, nem de um convidado para o dono, nem de um convidado para outro: conceder <c>module:pc</c> libera a tela, não
/// o computador de ninguém. Quem não tem PC próprio com o controle ligado recebe "nenhum PC". Com vários próprios, o
/// conectado vence, e depois o mais antigo.
/// </summary>
internal sealed class PcAgentResolver(DevicesDbContext db, IAgentPresenceReader presence)
{
    public async Task<PcTarget?> ResolveAsync(Guid userId, CancellationToken cancellationToken)
    {
        var agents = await db.Agents.AsNoTracking()
            .Where(a => a.RevokedAt == null && a.PairedBy == userId)
            .Select(a => new { a.Id, a.Slug, a.PairedBy, a.CreatedAt })
            .ToListAsync(cancellationToken);

        var candidates = agents
            .Select(a => (Agent: a, Info: presence.Get(a.Slug)))
            .Where(x => x.Info is not null && x.Info.Capabilities.Contains(PcMessages.Capability, StringComparer.Ordinal))
            .Select(x => new PcCandidate(x.Agent.Id, x.Agent.Slug, x.Agent.PairedBy, x.Agent.CreatedAt, x.Info!.Connected));

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
        return chosen is null ? null : new PcTarget(chosen.AgentId, chosen.Slug, chosen.Connected);
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
