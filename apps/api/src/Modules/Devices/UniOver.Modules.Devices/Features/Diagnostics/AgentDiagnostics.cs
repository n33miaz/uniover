using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Features.Diagnostics;

/// <summary>Os limites de retenção e de entrada dos diagnósticos dos agentes (curtos de propósito: é rastro, não histórico).</summary>
internal static class DiagnosticsLimits
{
    /// <summary>Quantos dias uma ocorrência fica guardada.</summary>
    public const int RetentionDays = 7;

    /// <summary>Quantas ocorrências por agente ficam guardadas, das mais novas para as mais velhas.</summary>
    public const int MaxPerAgent = 300;

    /// <summary>Quantas ocorrências um agente pode mandar por hora; o excedente é descartado.</summary>
    public const int MaxPerHour = 200;

    /// <summary>Quanto o relógio do agente pode estar adiantado antes de a hora dele ser trocada pela do recebimento.</summary>
    public static readonly TimeSpan FutureTolerance = TimeSpan.FromMinutes(5);

    public static readonly TimeSpan Retention = TimeSpan.FromDays(RetentionDays);

    public static readonly TimeSpan RateWindow = TimeSpan.FromHours(1);
}

/// <summary>Uma ocorrência lida do <c>agent.diagnostics.v1</c>, ainda sem validar contra o que a API aceita guardar.</summary>
internal sealed record DiagnosticInput(Guid EventId, DateTimeOffset At, string Kind, string Severity, string? Component, string Detail, int Count);

/// <summary>
/// Guarda os diagnósticos que o agente conta sobre si mesmo. Defensivo apesar de o contrato já ter sido conferido: o texto
/// vem de fora, então forma e tamanho valem de novo aqui, e o que não serve é descartado sem derrubar a conexão. O texto nunca
/// vai para o log da API.
/// </summary>
internal sealed partial class AgentDiagnosticsStore(DevicesDbContext db, TimeProvider time)
{
    private static readonly HashSet<string> Severities = new(StringComparer.Ordinal) { "info", "warn", "error" };

    /// <summary>Lê o corpo do <c>agent.diagnostics.v1</c>; item fora da forma é pulado, e o lote inteiro inválido vira vazio.</summary>
    public static IReadOnlyList<DiagnosticInput> Parse(JsonElement body)
    {
        var inputs = new List<DiagnosticInput>();
        if (body.ValueKind != JsonValueKind.Object
            || !body.TryGetProperty("events", out var events)
            || events.ValueKind != JsonValueKind.Array)
        {
            return inputs;
        }

        foreach (var item in events.EnumerateArray())
        {
            if (TryRead(item) is { } input)
            {
                inputs.Add(input);
            }
        }

        return inputs;
    }

    private static DiagnosticInput? TryRead(JsonElement item)
    {
        if (item.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var kind = Text(item, "kind");
        var severity = Text(item, "severity");
        var detail = Text(item, "detail");
        var component = Text(item, "component");
        if (!Guid.TryParse(Text(item, "id"), out var eventId)
            || !DateTimeOffset.TryParse(Text(item, "at"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at)
            || kind is not { Length: >= 2 and <= AgentDiagnosticEvent.KindMax } || !KindPattern().IsMatch(kind)
            || severity is null || !Severities.Contains(severity)
            || detail is not { Length: >= 1 and <= AgentDiagnosticEvent.DetailMax }
            || (component is not null && (component.Length > AgentDiagnosticEvent.ComponentMax || !ComponentPattern().IsMatch(component))))
        {
            return null;
        }

        var count = item.TryGetProperty("count", out var countElement) && countElement.TryGetInt32(out var parsed)
            ? Math.Clamp(parsed, 1, 10_000)
            : 1;
        return new DiagnosticInput(eventId, at, kind, severity, component, detail, count);
    }

    private static string? Text(JsonElement item, string name) =>
        item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    /// <summary>Grava o lote do agente de slug <paramref name="slug"/>. Agente desconhecido ou revogado: não grava nada.</summary>
    public async Task RecordAsync(string slug, IReadOnlyList<DiagnosticInput> inputs, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(inputs);
        if (inputs.Count == 0)
        {
            return;
        }

        var agentId = await db.Agents.AsNoTracking()
            .Where(a => a.Slug == slug && a.RevokedAt == null)
            .Select(a => (Guid?)a.Id)
            .SingleOrDefaultAsync(cancellationToken);
        if (agentId is null)
        {
            return;
        }

        var now = time.GetUtcNow();
        var hourAgo = now - DiagnosticsLimits.RateWindow;

        // O limite por hora conta só o que o agente mandou: o aviso de descarte da própria API não entra na conta.
        var received = await db.AgentDiagnosticEvents
            .CountAsync(e => e.AgentId == agentId && e.ReceivedAt > hourAgo && e.Kind != AgentDiagnosticEvent.DroppedKind, cancellationToken);
        var room = Math.Max(0, DiagnosticsLimits.MaxPerHour - received);

        var ids = inputs.Select(i => i.EventId).Distinct().ToList();
        var known = await db.AgentDiagnosticEvents.AsNoTracking()
            .Where(e => e.AgentId == agentId && ids.Contains(e.EventId))
            .Select(e => e.EventId)
            .ToListAsync(cancellationToken);
        var seen = new HashSet<Guid>(known);

        var accepted = 0;
        var dropped = false;
        foreach (var input in inputs)
        {
            if (!seen.Add(input.EventId))
            {
                continue;
            }

            if (accepted >= room)
            {
                dropped = true;
                continue;
            }

            accepted++;
            db.AgentDiagnosticEvents.Add(AgentDiagnosticEvent.Create(
                IdGenerator.NewId(), agentId.Value, input.EventId, ClampAt(input.At, now), now, input.Kind, input.Severity, input.Component, input.Detail, input.Count));
        }

        if (dropped && !await db.AgentDiagnosticEvents.AnyAsync(
                e => e.AgentId == agentId && e.Kind == AgentDiagnosticEvent.DroppedKind && e.ReceivedAt > hourAgo, cancellationToken))
        {
            db.AgentDiagnosticEvents.Add(AgentDiagnosticEvent.Create(
                IdGenerator.NewId(), agentId.Value, IdGenerator.NewId(), now, now, AgentDiagnosticEvent.DroppedKind, "warn", null,
                "O agente mandou eventos demais numa hora; o excedente foi descartado.", 1));
        }

        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException)
        {
            // O mesmo lote chegou por duas conexões ao mesmo tempo (índice único por evento): quem chegou antes já gravou.
            db.ChangeTracker.Clear();
        }

        await PruneAsync(agentId.Value, now, cancellationToken);
    }

    /// <summary>A hora do agente vale, a não ser que esteja no futuro ou fora da retenção: aí vale a do recebimento.</summary>
    private static DateTimeOffset ClampAt(DateTimeOffset at, DateTimeOffset now) =>
        at > now + DiagnosticsLimits.FutureTolerance || at < now - DiagnosticsLimits.Retention ? now : at;

    /// <summary>Retenção aplicada ao gravar, sem job de fundo: por tempo e depois por quantidade, só deste agente.</summary>
    private async Task PruneAsync(Guid agentId, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var floor = now - DiagnosticsLimits.Retention;
        await db.AgentDiagnosticEvents.Where(e => e.AgentId == agentId && e.At < floor).ExecuteDeleteAsync(cancellationToken);

        var surplus = await db.AgentDiagnosticEvents.AsNoTracking()
            .Where(e => e.AgentId == agentId)
            .OrderByDescending(e => e.At).ThenByDescending(e => e.Id)
            .Skip(DiagnosticsLimits.MaxPerAgent)
            .Select(e => e.Id)
            .ToListAsync(cancellationToken);
        if (surplus.Count > 0)
        {
            await db.AgentDiagnosticEvents.Where(e => surplus.Contains(e.Id)).ExecuteDeleteAsync(cancellationToken);
        }
    }

    [GeneratedRegex("^[a-z0-9][a-z0-9_.]{1,47}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex KindPattern();

    [GeneratedRegex("^[a-z0-9][a-z0-9_.]{0,31}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex ComponentPattern();
}

internal sealed record AgentDiagnosticItem(
    Guid Id, Guid AgentId, string AgentName, DateTimeOffset At, string Kind, string Severity, string? Component, string Detail, int Count);

/// <summary>As ocorrências dos agentes como o dono as vê, das mais novas para as mais velhas. <c>RetentionDays</c> diz por quanto tempo ficam.</summary>
internal sealed record AgentDiagnosticsResponse(int RetentionDays, IReadOnlyList<AgentDiagnosticItem> Items);

internal sealed class AgentDiagnosticsHandler(DevicesDbContext db, TimeProvider time)
{
    public const int DefaultLimit = 50;
    public const int MaxLimit = 100;

    public async Task<AgentDiagnosticsResponse> ListAsync(int limit, CancellationToken cancellationToken)
    {
        var floor = time.GetUtcNow() - DiagnosticsLimits.Retention;
        var rows = await (from e in db.AgentDiagnosticEvents.AsNoTracking()
                          join a in db.Agents.AsNoTracking() on e.AgentId equals a.Id
                          where a.RevokedAt == null && e.At >= floor
                          orderby e.At descending, e.Id descending
                          select new AgentDiagnosticItem(e.Id, e.AgentId, a.Name, e.At, e.Kind, e.Severity, e.Component, e.Detail, e.Count))
            .Take(limit)
            .ToListAsync(cancellationToken);
        return new AgentDiagnosticsResponse(DiagnosticsLimits.RetentionDays, rows);
    }
}

internal static class AgentDiagnosticsEndpoint
{
    public static void MapAgentDiagnostics(this IEndpointRouteBuilder group) =>
        group.MapGet("/agents/diagnostics", HandleAsync)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<AgentDiagnosticsResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static async Task<IResult> HandleAsync(
        int? limit, HttpContext http, AgentDiagnosticsHandler handler, CancellationToken cancellationToken)
    {
        var wanted = limit ?? AgentDiagnosticsHandler.DefaultLimit;
        if (wanted is < 1 or > AgentDiagnosticsHandler.MaxLimit)
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["limit"] = [$"Peça entre 1 e {AgentDiagnosticsHandler.MaxLimit} eventos."],
            });
        }

        // São textos do agente, só do administrador: nada em cache de navegador nem de proxy.
        http.Response.Headers.CacheControl = "no-store";
        return TypedResults.Ok(await handler.ListAsync(wanted, cancellationToken));
    }
}
