using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Messaging;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Contracts;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.TvLivre;
using UniOver.Modules.Tv.Features.Tvs;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;
using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Features.Agents;

/// <summary>
/// Trata o que o agente manda por iniciativa própria: o estado da TV, a lista de apps, os eventos do vigia e o relatório
/// da limpeza e o estado do TV Livre (que a requisição HTTP em espera recolhe pelo <c>requestId</c>). O
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
    ITvDiscoveryReports discoveryReports,
    TvLivreStore livreStore,
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
            AgentMessageTypes.TvCleanupResultV1, AgentMessageTypes.TvPermissionV1, AgentMessageTypes.TvDiscoveryV1,
            AgentMessageTypes.TvLivreStateV1,
        ];

    public async Task HandleAsync(InboundMessage message, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(message);

        // A lista de TVs achadas é de um computador que o administrador está escolhendo para uma TV nova: ele ainda não
        // controla TV nenhuma. Quem a espera é uma procura aberta para esse computador (o Devices já provou quem
        // mandou), então ela não passa pela regra "só o agente que controla a TV".
        if (string.Equals(message.Type, AgentMessageTypes.TvDiscoveryV1, StringComparison.Ordinal))
        {
            HandleDiscovery(message);
            return;
        }

        if (WritesTvRows(message.Type))
        {
            await HandleWritingAsync(message, cancellationToken);
            return;
        }

        // Estado e vigia não gravam linhas da TV (são por agente): sem bloqueio.
        var tv = await db.Tvs.AsNoTracking().SingleOrDefaultAsync(t => t.AgentSlug == message.AgentId, cancellationToken);
        if (!await ControlsTvAsync(tv, message, cancellationToken))
        {
            LogIgnored(message.AgentId, message.Type);
            return;
        }

        var tvId = tv?.Id ?? Guid.Empty;
        switch (message.Type)
        {
            case AgentMessageTypes.TvStateV1:
                HandleState(tvId, message);
                break;
            case AgentMessageTypes.TvWatchdogV1:
                await HandleWatchdogAsync(tvId, message, cancellationToken);
                break;
        }
    }

    /// <summary>Os tipos que gravam linhas com <c>tv_id</c> (atalhos, ícones, relatórios, TV Livre) ou a própria TV.</summary>
    private static bool WritesTvRows(string type) =>
        type is AgentMessageTypes.TvAppsV1 or AgentMessageTypes.TvAppsV2 or AgentMessageTypes.TvCleanupResultV1
            or AgentMessageTypes.TvLivreStateV1 or AgentMessageTypes.TvPermissionV1;

    /// <summary>
    /// Instalações que ainda dependem de AgentId não têm linha em tvs. Mantêm o comportamento anterior, mas só enquanto não
    /// houver TV salva para o agente: uma TV adicional nunca recebe mensagens por esse atalho.
    /// </summary>
    private async Task<bool> ControlsTvAsync(ConfiguredTv? tv, InboundMessage message, CancellationToken cancellationToken)
    {
        if (tv is not null)
        {
            return true;
        }

        var fallback = await agents.ResolveAsync(cancellationToken);
        return fallback.IsConfigured && string.Equals(fallback.AgentSlug, message.AgentId, StringComparison.Ordinal);
    }

    /// <summary>
    /// Grava o que o agente mandou sob o bloqueio da linha da TV, o mesmo que a remoção toma: a TV é lida JÁ com o bloqueio
    /// (uma remoção ou troca de computador em andamento termina antes, e a leitura vê o resultado) e nada é gravado se ela
    /// sumiu ou passou a outro computador. Sem isso, a mensagem enviada antes da remoção terminava de gravar depois dela e
    /// deixava atalhos, ícones e relatórios órfãos de uma TV que prometia ter sido limpa. O que vai para as telas sai depois
    /// do commit.
    /// </summary>
    private async Task HandleWritingAsync(InboundMessage message, CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var tv = await TvRowLock.LockByAgentAsync(db, message.AgentId, cancellationToken);
        if (!await ControlsTvAsync(tv, message, cancellationToken))
        {
            LogDropped(message.AgentId, message.Type);
            return;
        }

        var tvId = tv?.Id ?? Guid.Empty;
        var publishShortcuts = false;
        switch (message.Type)
        {
            case AgentMessageTypes.TvAppsV1:
            case AgentMessageTypes.TvAppsV2:
                await StoreAppsAsync(tvId, message, cancellationToken);
                publishShortcuts = true;
                break;
            case AgentMessageTypes.TvLivreStateV1:
                await HandleLivreStateAsync(tvId, message, cancellationToken);
                break;
            case AgentMessageTypes.TvCleanupResultV1:
                await HandleCleanupResultAsync(tvId, message, cancellationToken);
                break;
            case AgentMessageTypes.TvPermissionV1:
                await HandlePermissionAsync(tv, message, cancellationToken);
                break;
        }

        await transaction.CommitAsync(cancellationToken);

        if (publishShortcuts)
        {
            // Mesmo sem mudança a tela recebe a lista: quem pediu a atualização espera ver a resposta.
            stream.PublishShortcuts(tvId, await shortcutReader.ListAsync(tvId, cancellationToken));
        }
    }

    /// <summary>
    /// O agente diz se a TV Samsung ainda reconhece o UniOver. Grava só quando muda (ele repete o aviso a cada conexão).
    /// Sem linha de TV (instalação antiga, só por <c>AgentId</c>) não há onde guardar e o aviso é ignorado.
    /// </summary>
    private async Task HandlePermissionAsync(ConfiguredTv? tv, InboundMessage message, CancellationToken cancellationToken)
    {
        if (tv is null)
        {
            return;
        }

        var needed = string.Equals(message.Body.GetProperty("state").GetString(), "needed", StringComparison.Ordinal);
        if (tv.SetPermissionNeeded(needed, message.Body.GetProperty("at").GetDateTimeOffset()))
        {
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    /// <summary>Entrega a lista de TVs achadas ao pedido que a espera (<c>requestId</c>); o resto é ignorado.</summary>
    private void HandleDiscovery(InboundMessage message)
    {
        var body = message.Body;
        var tvs = body.GetProperty("tvs").EnumerateArray()
            .Select(item => new TvNearby(
                item.GetProperty("id").GetString()!,
                item.GetProperty("kind").GetString()!,
                item.GetProperty("name").GetString(),
                item.GetProperty("controlled").GetBoolean()))
            .ToList();
        discoveryReports.Complete(message.AgentId, body.GetProperty("requestId").GetGuid(), tvs);
    }

    /// <summary>
    /// Guarda o último estado do TV Livre da TV. Quem espera por ele (o pedido HTTP, que pode estar em OUTRA instância da API)
    /// o encontra no banco pelo <c>requestId</c>, então não há sinal em memória a mandar. O agente manda o estado depois de
    /// CADA passo, inclusive dos que falharam, e os de outro agente nem chegam aqui (a conferência do agente que controla a TV
    /// é a do início de <see cref="HandleAsync"/>).
    /// </summary>
    private async Task HandleLivreStateAsync(Guid tvId, InboundMessage message, CancellationToken cancellationToken)
    {
        var body = message.Body;
        var requestId = body.GetProperty("requestId").GetGuid();
        var entry = await livreStore.EnsureAsync(tvId, cancellationToken);
        entry.SaveState(body.GetRawText(), requestId, body.GetProperty("at").GetDateTimeOffset(), time.GetUtcNow());
        await db.SaveChangesAsync(cancellationToken);
    }

    private async Task HandleCleanupResultAsync(Guid tvId, InboundMessage message, CancellationToken cancellationToken)
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
                steps,
                body.TryGetProperty("closedPackages", out var closedPackages)
                    ? closedPackages.EnumerateArray().Select(package => package.GetString()!).ToList()
                    : null));

        // Relatórios automáticos não têm uma requisição HTTP esperando. Eles precisam entrar no
        // banco aqui, inclusive os pulos que explicam por que a TV não foi tocada.
        if (!body.TryGetProperty("kind", out var kindValue) || kindValue.GetString() is not { } kind)
            return;
        var trigger = body.TryGetProperty("trigger", out var triggerValue)
            ? triggerValue.GetString() ?? "automatic" : "automatic";
        var result = body.TryGetProperty("result", out var resultValue)
            ? resultValue.GetString() ?? "completed" : "completed";
        if (string.Equals(result, "skipped", StringComparison.Ordinal))
        {
            var reason = body.TryGetProperty("reason", out var reasonValue)
                ? reasonValue.GetString() ?? "unknown" : "unknown";
            db.CleanupReports.Add(CleanupReportEntry.Skipped(tvId, kind, trigger, message.Timestamp, reason));
        }
        else
        {
            var duration = body.TryGetProperty("durationMs", out var durationValue)
                && durationValue.TryGetInt32(out var milliseconds) ? milliseconds : 0;
            db.CleanupReports.Add(CleanupReportEntry.Completed(
                tvId, kind, trigger, message.Timestamp, duration,
                OptionalMegabytes(body, "memoryBeforeMb"), OptionalMegabytes(body, "memoryAfterMb"),
                body.GetProperty("closedApps").GetInt32(),
                JsonSerializer.Serialize(body.TryGetProperty("closedPackages", out var packages)
                    ? packages.EnumerateArray().Select(package => package.GetString()!).ToArray()
                    : Array.Empty<string>()),
                OptionalInt(body, "backgroundProcesses"), OptionalInt(body, "sessionOpenMs")));
        }
        await db.SaveChangesAsync(cancellationToken);
    }

    private static int? OptionalMegabytes(JsonElement body, string name) =>
        body.GetProperty(name) is { ValueKind: JsonValueKind.Number } value ? value.GetInt32() : null;

    private static int? OptionalInt(JsonElement body, string name) =>
        body.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetInt32() : null;

    private void HandleState(Guid tvId, InboundMessage message)
    {
        var body = message.Body;
        var snapshot = new TvStateSnapshot(
            body.GetProperty("power").GetString()!,
            body.GetProperty("volume") is { ValueKind: JsonValueKind.Number } volume ? volume.GetInt32() : null,
            body.GetProperty("app").GetString(),
            body.GetProperty("connection").GetString()!,
            message.Timestamp,
            ReadAdbPermission(body),
            ReadAdbPermissionReason(body),
            ReadWakeHints(body));

        // Um estado vindo do agente prova que ele está conectado.
        state.NoteOnline(message.AgentId, true);
        state.Apply(message.AgentId, snapshot);
        stream.PublishState(tvId, TvState.From(snapshot, agentOnline: true));
        persister.Observe(message.AgentId, snapshot);
    }

    /// <summary>A permissão do ADB do estado (campo opcional): ausente ou fora da lista vira "não se sabe".</summary>
    private static string? ReadAdbPermission(JsonElement body) =>
        body.TryGetProperty("adbPermission", out var value) && value.ValueKind == JsonValueKind.String
        && AdbPermissionText.IsKnown(value.GetString())
            ? value.GetString()
            : null;

    /// <summary>O motivo do estado (campo opcional, só com <c>missing</c>): fora da forma curta vira "sem motivo".</summary>
    private static string? ReadAdbPermissionReason(JsonElement body) =>
        body.TryGetProperty("adbPermissionReason", out var value) && value.ValueKind == JsonValueKind.String
        && AdbPermissionText.IsReason(value.GetString())
            ? value.GetString()
            : null;

    /// <summary>Os avisos de ligar pela rede (campo opcional): só os valores conhecidos passam; nenhum vira "nada a avisar".</summary>
    private static string[]? ReadWakeHints(JsonElement body)
    {
        if (!body.TryGetProperty("wakeHints", out var value) || value.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var hints = value.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.String && WakeHintText.IsKnown(item.GetString()))
            .Select(item => item.GetString()!)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        return hints.Length == 0 ? null : hints;
    }

    private async Task StoreAppsAsync(Guid tvId, InboundMessage message, CancellationToken cancellationToken)
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

    [LoggerMessage(Level = LogLevel.Information, Message = "Mensagem {Type} do agente {AgentId} descartada sem gravar: a TV dele foi removida ou passou a outro computador.")]
    private partial void LogDropped(string agentId, string type);

    [LoggerMessage(Level = LogLevel.Debug, Message = "Mensagem {Type} do agente {AgentId} ignorada: não é o agente que controla a TV.")]
    private partial void LogIgnored(string agentId, string type);
}
