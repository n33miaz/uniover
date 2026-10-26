using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;

namespace UniOver.Modules.Devices.Features.Presence;

/// <summary>
/// Persiste um resumo da presença sem transformar cada batimento em escrita. A memória deste singleton evita até a
/// consulta repetida; depois de um deploy a primeira mensagem confere a hora já guardada antes de voltar a gravar.
/// O <c>hello</c> repetido e o mesmo estado de atualização também não geram escrita. Falha ao gravar só é registrada:
/// o resumo é informativo e não pode derrubar a conexão do agente.
/// </summary>
internal sealed partial class AgentPresencePersistence(IServiceScopeFactory scopes, ILogger<AgentPresencePersistence> logger)
{
    private static readonly TimeSpan LastSeenInterval = TimeSpan.FromMinutes(1);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _lastSeenWrites = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, HelloDetails> _hellos = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, AgentUpdateInfo> _updates = new(StringComparer.Ordinal);

    private sealed record HelloDetails(string AgentVersion, AgentHostInfo? Host);

    public Task RecordConnectedAsync(string agentId, DateTimeOffset now, CancellationToken cancellationToken) =>
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

    public Task TouchAsync(string agentId, DateTimeOffset now, CancellationToken cancellationToken) =>
        SaveAsync(agentId, now, forceLastSeen: false, agentVersion: null, host: null, update: null, cancellationToken);

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
        if (!forceLastSeen && !helloChanged && !updateChanged && IsRecent(agentId, now))
        {
            return;
        }

        try
        {
            await WriteAsync(agentId, now, forceLastSeen, helloChanged ? hello : null, updateChanged ? update : null, cancellationToken);
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
        bool forceLastSeen,
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
        if (snapshot is null)
        {
            snapshot = AgentPresenceSnapshot.Create(agentIdValue.Value);
            db.AgentPresenceSnapshots.Add(snapshot);
        }

        var lastSeenWritten = false;
        if (forceLastSeen || !IsRecent(snapshot.LastSeenAt, now))
        {
            snapshot.RecordLastSeen(now);
            lastSeenWritten = true;
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

        // Só depois de gravar: uma falha não pode fazer o cache achar que já está no banco.
        if (lastSeenWritten)
        {
            _lastSeenWrites[agentId] = now;
        }
        else if (snapshot.LastSeenAt is { } lastSeen)
        {
            _lastSeenWrites.TryAdd(agentId, lastSeen);
        }

        if (hello is not null)
        {
            _hellos[agentId] = hello;
        }

        if (update is not null)
        {
            _updates[agentId] = update;
        }
    }

    private bool IsRecent(string agentId, DateTimeOffset now) =>
        _lastSeenWrites.TryGetValue(agentId, out var lastSeen) && IsRecent(lastSeen, now);

    private static bool IsRecent(DateTimeOffset? lastSeen, DateTimeOffset now) =>
        lastSeen is not null && now >= lastSeen.Value && now - lastSeen.Value < LastSeenInterval;

    [LoggerMessage(Level = LogLevel.Warning, Message = "Não foi possível gravar o resumo de presença do agente {AgentId} ({Error}).")]
    private partial void LogWriteFailed(string agentId, string error);
}
