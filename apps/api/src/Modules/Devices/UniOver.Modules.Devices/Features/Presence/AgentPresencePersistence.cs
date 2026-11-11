using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;

namespace UniOver.Modules.Devices.Features.Presence;

/// <summary>
/// Persiste um resumo da presença sem transformar cada batimento em escrita: o Neon gratuito dorme sem consulta, e um agente
/// conectado dia e noite que gravasse "visto agora" todo minuto o manteria acordado o mês inteiro. O último sinal
/// (<c>last_seen_at</c>) só é gravado ao conectar, ao desconectar e quando o <c>hello</c> traz algo novo (versão ou
/// computador); enquanto o agente está conectado, quem mostra "visto agora" é a presença em memória (ver
/// <c>AgentConnections</c>). O <c>hello</c> repetido e o mesmo estado de atualização não geram escrita nenhuma, nem consulta.
/// Falha ao gravar só é registrada: o resumo é informativo e não pode derrubar a conexão do agente.
/// </summary>
internal sealed partial class AgentPresencePersistence(IServiceScopeFactory scopes, ILogger<AgentPresencePersistence> logger)
{
    private readonly ConcurrentDictionary<string, HelloDetails> _hellos = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, AgentUpdateInfo> _updates = new(StringComparer.Ordinal);

    private sealed record HelloDetails(string AgentVersion, AgentHostInfo? Host);

    public Task RecordConnectedAsync(string agentId, DateTimeOffset now, CancellationToken cancellationToken) =>
        SaveAsync(agentId, now, forceLastSeen: true, agentVersion: null, host: null, update: null, cancellationToken);

    /// <summary>
    /// A instância vai parar (o deploy mandou o SIGTERM): grava "visto agora" de quem está conectado a ela. Sem batimento no banco,
    /// o último sinal de um agente conectado há dias é antigo, e a instância que assume não pode achar que ele sumiu.
    /// </summary>
    public Task RecordSeenAsync(string agentId, DateTimeOffset now, CancellationToken cancellationToken) =>
        SaveAsync(agentId, now, forceLastSeen: true, agentVersion: null, host: null, update: null, cancellationToken);

    public Task RecordDisconnectedAsync(string agentId, DateTimeOffset now, CancellationToken cancellationToken) =>
        SaveAsync(agentId, now, forceLastSeen: true, agentVersion: null, host: null, update: null, cancellationToken);

    public Task RecordHelloAsync(
        string agentId,
        string agentVersion,
        AgentHostInfo? host,
        AgentUpdateInfo? update,
        DateTimeOffset now,
        CancellationToken cancellationToken) =>
        SaveAsync(agentId, now, forceLastSeen: false, agentVersion, host, update, cancellationToken);

    public Task RecordUpdateAsync(
        string agentId,
        AgentUpdateInfo update,
        DateTimeOffset now,
        CancellationToken cancellationToken) =>
        SaveAsync(agentId, now, forceLastSeen: false, agentVersion: null, host: null, update, cancellationToken);

    private async Task SaveAsync(
        string agentId,
        DateTimeOffset now,
        bool forceLastSeen,
        string? agentVersion,
        AgentHostInfo? host,
        AgentUpdateInfo? update,
        CancellationToken cancellationToken)
    {
        var hello = agentVersion is null ? null : new HelloDetails(agentVersion, host);
        var helloChanged = hello is not null && !(_hellos.TryGetValue(agentId, out var knownHello) && knownHello == hello);
        var updateChanged = update is not null && !(_updates.TryGetValue(agentId, out var knownUpdate) && knownUpdate == update);
        if (!forceLastSeen && !helloChanged && !updateChanged)
        {
            return;
        }

        try
        {
            // Um hello que muda a versão ou o computador também renova o último sinal; o de atualização, não.
            await WriteAsync(agentId, now, forceLastSeen || helloChanged, helloChanged ? hello : null, updateChanged ? update : null, cancellationToken);
        }
#pragma warning disable CA1031 // O resumo é informativo: falha do banco não pode derrubar a conexão do agente.
        catch (Exception exception) when (exception is not OperationCanceledException)
#pragma warning restore CA1031
        {
            LogWriteFailed(agentId, exception.GetType().Name);
        }
    }

    private async Task WriteAsync(
        string agentId,
        DateTimeOffset now,
        bool writeLastSeen,
        HelloDetails? hello,
        AgentUpdateInfo? update,
        CancellationToken cancellationToken)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<DevicesDbContext>();
        // Agente revogado (ou desconhecido) não ganha resumo novo: o slug só vale para o agente ativo.
        var agentIdValue = await db.Agents.AsNoTracking()
            .Where(agent => agent.Slug == agentId && agent.RevokedAt == null)
            .Select(agent => (Guid?)agent.Id)
            .SingleOrDefaultAsync(cancellationToken);
        if (agentIdValue is null)
        {
            return;
        }

        var snapshot = await db.AgentPresenceSnapshots
            .SingleOrDefaultAsync(item => item.AgentId == agentIdValue.Value, cancellationToken);
        var isNew = snapshot is null;
        if (snapshot is null)
        {
            snapshot = AgentPresenceSnapshot.Create(agentIdValue.Value);
            db.AgentPresenceSnapshots.Add(snapshot);
        }

        // O último sinal só avança (comparar e trocar no banco): durante a troca de instância na publicação a instância antiga
        // ainda grava a queda da sua conexão enquanto a nova já gravou a conexão do mesmo agente, e o dado mais velho não pode
        // sobrescrever o mais novo. Linha nova entra já com o valor; a existente é atualizada abaixo, num só UPDATE condicional.
        if (writeLastSeen && isNew)
        {
            snapshot.RecordLastSeen(now);
        }

        if (hello is not null)
        {
            snapshot.RecordHello(hello.AgentVersion, hello.Host);
        }

        if (update is not null)
        {
            snapshot.RecordUpdate(update);
        }

        await db.SaveChangesAsync(cancellationToken);

        if (writeLastSeen && !isNew)
        {
            await db.AgentPresenceSnapshots
                .Where(item => item.AgentId == agentIdValue.Value && (item.LastSeenAt == null || item.LastSeenAt < now))
                .ExecuteUpdateAsync(set => set.SetProperty(item => item.LastSeenAt, now), cancellationToken);
        }

        // Só depois de gravar: uma falha não pode fazer a memória achar que já está no banco.
        if (hello is not null)
        {
            _hellos[agentId] = hello;
        }

        if (update is not null)
        {
            _updates[agentId] = update;
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Não foi possível gravar o resumo de presença do agente {AgentId} ({Error}).")]
    private partial void LogWriteFailed(string agentId, string error);
}
