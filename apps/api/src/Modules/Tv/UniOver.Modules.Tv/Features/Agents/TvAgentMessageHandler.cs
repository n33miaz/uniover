using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Messaging;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Contracts;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;
using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Features.Agents;

/// <summary>
/// Trata o que o agente manda por iniciativa própria: o estado da TV, a lista de apps, os eventos do vigia e o relatório
/// da limpeza (que a requisição HTTP em espera recolhe pelo <c>requestId</c>). O
/// Devices já validou a mensagem contra o contrato, então os campos existem e têm o tipo certo. Só vale o agente
/// que controla a TV agora (o salvo no app, ou a variável de reserva): mensagem de outro agente pareado é ignorada,
/// inclusive a do computador que foi trocado.
/// </summary>
internal sealed partial class TvAgentMessageHandler(
    ITvAgentResolver agents,
    ITvStateStore state,
    TvStatePersister persister,
    ITvStreamPublisher stream,
    ITvCleanupReports cleanupReports,
    ITvShortcutReader shortcutReader,
    IAgentPresenceReader presence,
    TvDbContext db,
    IEventBus events,
    TimeProvider time,
    ILogger<TvAgentMessageHandler> logger) : IAgentMessageHandler
{
    public const int WatchdogMaxRows = 500;

    public IReadOnlyCollection<string> HandledTypes { get; } =
        [
            AgentMessageTypes.TvStateV1, AgentMessageTypes.TvAppsV1, AgentMessageTypes.TvAppsV2, AgentMessageTypes.TvWatchdogV1,
            AgentMessageTypes.TvCleanupResultV1,
        ];

    public async Task HandleAsync(InboundMessage message, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(message);

        var tv = await db.Tvs.SingleOrDefaultAsync(t => t.AgentSlug == message.AgentId, cancellationToken);
        var tvId = tv?.Id ?? Guid.Empty;
        if (tv is null)
        {
            // Instalações que ainda dependem de AgentId não têm linha em tvs. Mantêm o comportamento anterior, mas só
            // enquanto não houver TV salva para o agente: uma TV adicional nunca recebe mensagens por esse atalho.
            var fallback = await agents.ResolveAsync(cancellationToken);
            if (!fallback.IsConfigured || !string.Equals(fallback.AgentSlug, message.AgentId, StringComparison.Ordinal))
            {
                LogIgnored(message.AgentId, message.Type);
                return;
            }
        }

        switch (message.Type)
        {
            case AgentMessageTypes.TvStateV1:
                HandleState(tvId, message);
                break;
            case AgentMessageTypes.TvAppsV1:
            case AgentMessageTypes.TvAppsV2:
                await HandleAppsAsync(tvId, message, cancellationToken);
                break;
            case AgentMessageTypes.TvWatchdogV1:
                await HandleWatchdogAsync(tvId, message, cancellationToken);
                break;
            case AgentMessageTypes.TvCleanupResultV1:
                HandleCleanupResult(tvId, message);
                break;
        }
    }

    private void HandleCleanupResult(Guid tvId, InboundMessage message)
    {
        var body = message.Body;
        var steps = body.GetProperty("failedSteps").EnumerateArray().Select(s => s.GetString()!).ToList();
        cleanupReports.Complete(
            tvId,
            body.GetProperty("requestId").GetGuid(),
            new TvCleanupReport(
                body.GetProperty("closedApps").GetInt32(),
                OptionalMegabytes(body, "memoryBeforeMb"),
                OptionalMegabytes(body, "memoryAfterMb"),
                OptionalMegabytes(body, "freedMb"),
                steps));
    }

    private static int? OptionalMegabytes(JsonElement body, string name) =>
        body.GetProperty(name) is { ValueKind: JsonValueKind.Number } value ? value.GetInt32() : null;

    private void HandleState(Guid tvId, InboundMessage message)
    {
        var body = message.Body;
        var snapshot = new TvStateSnapshot(
            body.GetProperty("power").GetString()!,
            body.GetProperty("volume") is { ValueKind: JsonValueKind.Number } volume ? volume.GetInt32() : null,
            body.GetProperty("app").GetString(),
            body.GetProperty("connection").GetString()!,
            message.Timestamp);

        // Um estado vindo do agente prova que ele está conectado.
        state.NoteOnline(message.AgentId, true);
        state.Apply(message.AgentId, snapshot);
        stream.PublishState(tvId, TvState.From(snapshot, agentOnline: true));
        persister.Observe(message.AgentId, snapshot);
    }

    private async Task HandleAppsAsync(Guid tvId, InboundMessage message, CancellationToken cancellationToken)
    {
        // `tv.apps.v1` não traz ícone; `tv.apps.v2` pode trazer, app por app. Sem o campo, o ícone guardado fica.
        var incoming = message.Body.GetProperty("apps").EnumerateArray()
            .Select(a => new IncomingApp(a.GetProperty("package").GetString()!, a.GetProperty("label").GetString(), ReadIcon(a, message.AgentId)))
            .ToList();

        var existing = await db.Shortcuts.Where(s => s.TvId == tvId).ToListAsync(cancellationToken);
        var (added, changed) = ShortcutCatalog.Merge(existing, incoming, time.GetUtcNow(), tvId);
        db.Shortcuts.AddRange(added);
        IReadOnlyList<string> capabilities = presence.Get(message.AgentId)?.Capabilities ?? [];
        var foreign = existing.Where(shortcut => ShortcutFamily.IsForeignUninstalled(shortcut, capabilities)).ToList();
        db.Shortcuts.RemoveRange(foreign);
        if (changed || foreign.Count > 0)
        {
            await db.SaveChangesAsync(cancellationToken);
        }

        // Mesmo sem mudança a tela recebe a lista: quem pediu a atualização espera ver a resposta.
        stream.PublishShortcuts(tvId, await shortcutReader.ListAsync(tvId, cancellationToken));
    }

    /// <summary>
    /// Lê o ícone de um app de <c>tv.apps.v2</c>. Ícone inválido (tipo, base64, tamanho ou conteúdo) é descartado com um
    /// aviso curto, sem o conteúdo, e o app continua na lista: um ícone ruim nunca derruba a lista de atalhos.
    /// </summary>
    private ShortcutIcon? ReadIcon(JsonElement app, string agentId)
    {
        if (!app.TryGetProperty("icon", out var icon) || icon.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var mime = icon.TryGetProperty("mime", out var m) ? m.GetString() : null;
        var data = icon.TryGetProperty("data", out var d) ? d.GetString() : null;
        if (ShortcutIcon.TryCreate(mime, data, out var parsed))
        {
            return parsed;
        }

        LogIconRejected(agentId, app.GetProperty("package").GetString() ?? string.Empty);
        return null;
    }

    private async Task HandleWatchdogAsync(Guid tvId, InboundMessage message, CancellationToken cancellationToken)
    {
        var body = message.Body;
        var kind = body.GetProperty("kind").GetString()!;
        var severity = body.GetProperty("severity").GetString()!;
        var detail = body.GetProperty("detail").GetString()!;
        var attempts = body.GetProperty("attempts").GetInt32();
        var at = body.GetProperty("at").GetDateTimeOffset();
        var now = time.GetUtcNow();

        db.WatchdogEvents.Add(WatchdogEvent.Create(message.AgentId, kind, severity, detail, attempts, at, now));
        await events.PublishAsync(
            new TvWatchdogRecorded(IdGenerator.NewId(), now, message.AgentId, kind, severity, detail, attempts, at),
            cancellationToken);
        await db.SaveChangesAsync(cancellationToken);

        // Retenção oportunista: o vigia fala pouco, então limpar a cada inserção custa quase nada.
        var boundary = await db.WatchdogEvents
            .OrderByDescending(w => w.ReceivedAt)
            .Skip(WatchdogMaxRows)
            .Select(w => (DateTimeOffset?)w.ReceivedAt)
            .FirstOrDefaultAsync(cancellationToken);
        if (boundary is { } oldest)
        {
            await db.WatchdogEvents.Where(w => w.ReceivedAt <= oldest).ExecuteDeleteAsync(cancellationToken);
        }

        stream.PublishWatchdog(tvId, new TvWatchdogEntry(kind, severity, detail, attempts, at));
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Ícone do app {Package} do agente {AgentId} recusado (tipo, base64, tamanho ou conteúdo inválido).")]
    private partial void LogIconRejected(string agentId, string package);

    [LoggerMessage(Level = LogLevel.Debug, Message = "Mensagem {Type} do agente {AgentId} ignorada: não é o agente que controla a TV.")]
    private partial void LogIgnored(string agentId, string type);
}
