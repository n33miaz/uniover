using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Features.ClientEvents;

/// <summary>Os limites da telemetria do app (curtos de propósito: é rastro para o dono, não histórico).</summary>
internal static class ClientEventLimits
{
    /// <summary>Quantos dias uma ocorrência fica guardada.</summary>
    public const int RetentionDays = 7;

    /// <summary>Teto de linhas na tabela inteira; passou disso, as mais velhas saem (o banco grátis é pequeno).</summary>
    public const int MaxRows = 2_000;

    /// <summary>Quantas ocorrências a API aceita por hora, somando todos os aparelhos; o excedente é descartado.</summary>
    public const int MaxPerHour = 600;

    /// <summary>
    /// A chave do bloqueio de transação (<c>pg_advisory_xact_lock</c>) que serializa a conta do teto por hora: sem ele, envios
    /// simultâneos veriam todos o mesmo espaço livre e passariam do teto. Vale por transação e entre instâncias da API.
    /// </summary>
    public const long HourlyCapLockKey = 0x55_4F_43_45_56_54; // "UOCEVT"

    /// <summary>Quantas ocorrências cabem num envio (o app manda no máximo isto).</summary>
    public const int MaxPerBatch = 20;

    /// <summary>Tamanho máximo do corpo; o que passar disso é recusado sem ser lido.</summary>
    public const int MaxBodyBytes = 16 * 1024;

    /// <summary>Quanto o relógio do aparelho pode estar adiantado antes de a hora dele ser trocada pela do recebimento.</summary>
    public static readonly TimeSpan FutureTolerance = TimeSpan.FromMinutes(5);

    public static readonly TimeSpan Retention = TimeSpan.FromDays(RetentionDays);

    public static readonly TimeSpan RateWindow = TimeSpan.FromHours(1);
}

/// <summary>Uma ocorrência como o app a manda. Só descreve o contrato: a conferência é feita à mão (ver <see cref="ClientEventValidator"/>).</summary>
internal sealed record ClientEventItem(
    Guid? Id,
    DateTimeOffset? At,
    string? Kind,
    string? Module,
    string? Code,
    int? Status,
    string? TraceId,
    string? Transport,
    string? Visibility,
    string? Route,
    string? Api,
    string? Version,
    bool? Grace);

/// <summary>O corpo do envio: até <see cref="ClientEventLimits.MaxPerBatch"/> ocorrências.</summary>
internal sealed record ClientEventsBody(IReadOnlyList<ClientEventItem>? Events);

/// <summary>
/// Confere cada ocorrência contra formas fixas. O app já limpa tudo antes de mandar, mas a API não confia nele: o que não tem a
/// forma esperada é descartado (a ocorrência inteira, nunca "consertada"), e nenhum campo aceita texto livre.
/// </summary>
internal static partial class ClientEventValidator
{
    private static readonly HashSet<string> Kinds = new(StringComparer.Ordinal) { "client-error", "http-failure", "command-failure", "command-slow" };
    private static readonly HashSet<string> Modules = new(StringComparer.Ordinal) { "tv", "pc", "training", "app" };
    private static readonly HashSet<string> Transports = new(StringComparer.Ordinal) { "cloud", "direct" };
    private static readonly HashSet<string> Visibilities = new(StringComparer.Ordinal) { "visible", "hidden" };

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9_.:-]{0,47}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex CodePattern();

    [GeneratedRegex("^[A-Za-z0-9-]{8,64}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex TracePattern();

    // Caminho: só barras e trechos no alfabeto seguro (os identificadores já chegam como ":id"); nada de query, espaço ou acento.
    [GeneratedRegex("^/[A-Za-z0-9_.:/-]{0,119}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex RoutePattern();

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9.+_-]{0,39}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex VersionPattern();

    /// <summary>A ocorrência conferida, ou <c>null</c> se qualquer campo estiver fora da forma.</summary>
    public static ValidClientEvent? Validate(ClientEventItem item)
    {
        ArgumentNullException.ThrowIfNull(item);
        try
        {
            if (item.Id is not { } id || id == Guid.Empty
                || item.At is not { } at
                || item.Kind is not { } kind || !Kinds.Contains(kind)
                || item.Module is not { } module || !Modules.Contains(module)
                || item.Visibility is not { } visibility || !Visibilities.Contains(visibility)
                || item.Route is not { } route || !RoutePattern().IsMatch(route))
            {
                return null;
            }

            if (!IsOptional(item.Code, static c => CodePattern().IsMatch(c))
                || !IsOptional(item.TraceId, static t => TracePattern().IsMatch(t))
                || !IsOptional(item.Transport, static t => Transports.Contains(t))
                || !IsOptional(item.Api, static a => RoutePattern().IsMatch(a))
                || !IsOptional(item.Version, static v => VersionPattern().IsMatch(v))
                || item.Status is < 0 or > 599)
            {
                return null;
            }

            return new ValidClientEvent(
                id, at, kind, module, item.Code, item.Status, item.TraceId, item.Transport, visibility, route, item.Api, item.Version, item.Grace == true);
        }
        catch (RegexMatchTimeoutException)
        {
            return null;
        }
    }

    private static bool IsOptional(string? value, Func<string, bool> accepts) => value is null || accepts(value);
}

/// <summary>Uma ocorrência já conferida, pronta para gravar.</summary>
internal sealed record ValidClientEvent(
    Guid EventId,
    DateTimeOffset At,
    string Kind,
    string Module,
    string? Code,
    int? Status,
    string? TraceId,
    string? Transport,
    string Visibility,
    string Route,
    string? Api,
    string? Version,
    bool Grace);

/// <summary>
/// Guarda e lê a telemetria do app. A retenção é por tempo e por quantidade (sem job só para isso na escrita: a poda roda ao gravar,
/// e o mesmo trabalho de hora em hora que limpa os diagnósticos dos agentes limpa esta tabela também).
/// </summary>
internal sealed class ClientEventStore(DevicesDbContext db, TimeProvider time)
{
    /// <summary>Grava o que serve do lote e devolve quantas ocorrências entraram. O texto nunca vai para o log.</summary>
    public async Task<int> RecordAsync(Guid userId, IReadOnlyList<ClientEventItem> items, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(items);
        var valid = new List<ValidClientEvent>();
        foreach (var item in items.Take(ClientEventLimits.MaxPerBatch))
        {
            if (item is not null && ClientEventValidator.Validate(item) is { } checkedEvent)
            {
                valid.Add(checkedEvent);
            }
        }

        if (valid.Count == 0)
        {
            return 0;
        }

        var now = time.GetUtcNow();
        var hourAgo = now - ClientEventLimits.RateWindow;

        // Contar o espaço e gravar é um passo só: o bloqueio de transação faz um envio esperar o outro, então o teto por hora vale
        // mesmo com vários aparelhos enviando ao mesmo tempo.
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        await db.Database.ExecuteSqlAsync($"SELECT pg_advisory_xact_lock({ClientEventLimits.HourlyCapLockKey})", cancellationToken);

        // O teto por hora é da API inteira: um app com defeito em laço não enche o banco.
        var received = await db.ClientEvents.CountAsync(e => e.ReceivedAt > hourAgo, cancellationToken);
        var room = Math.Max(0, ClientEventLimits.MaxPerHour - received);
        if (room == 0)
        {
            return 0;
        }

        var ids = valid.Select(v => v.EventId).Distinct().ToList();
        var known = await db.ClientEvents.AsNoTracking()
            .Where(e => ids.Contains(e.EventId))
            .Select(e => e.EventId)
            .ToListAsync(cancellationToken);
        var seen = new HashSet<Guid>(known);

        var accepted = 0;
        foreach (var input in valid)
        {
            if (accepted >= room)
            {
                break;
            }

            if (!seen.Add(input.EventId))
            {
                continue;
            }

            accepted++;
            db.ClientEvents.Add(ClientEvent.Create(
                IdGenerator.NewId(), userId, input.EventId, ClampAt(input.At, now), now, input.Kind, input.Module, input.Code, input.Status,
                input.TraceId, input.Transport, input.Visibility, input.Route, input.Api, input.Version, input.Grace));
        }

        if (accepted == 0)
        {
            return 0;
        }

        try
        {
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (DbUpdateException)
        {
            // O mesmo lote chegou duas vezes ao mesmo tempo (índice único por evento): quem chegou antes já gravou.
            db.ChangeTracker.Clear();
            return 0;
        }

        await PruneAsync(now, cancellationToken);
        return accepted;
    }

    /// <summary>A hora do aparelho vale, a não ser que esteja no futuro ou fora da retenção: aí vale a do recebimento.</summary>
    private static DateTimeOffset ClampAt(DateTimeOffset at, DateTimeOffset now) =>
        at > now + ClientEventLimits.FutureTolerance || at < now - ClientEventLimits.Retention ? now : at;

    /// <summary>Retenção aplicada ao gravar: por tempo e depois por quantidade, na tabela inteira.</summary>
    private async Task PruneAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var floor = now - ClientEventLimits.Retention;
        await db.ClientEvents.Where(e => e.At < floor).ExecuteDeleteAsync(cancellationToken);

        var surplus = await db.ClientEvents.AsNoTracking()
            .OrderByDescending(e => e.At).ThenByDescending(e => e.Id)
            .Skip(ClientEventLimits.MaxRows)
            .Select(e => e.Id)
            .ToListAsync(cancellationToken);
        if (surplus.Count > 0)
        {
            await db.ClientEvents.Where(e => surplus.Contains(e.Id)).ExecuteDeleteAsync(cancellationToken);
        }
    }

    /// <summary>A retenção de tempo vale para a tabela toda, não só quando alguém ainda envia. Devolve quantas linhas saíram.</summary>
    public async Task<int> PurgeExpiredAsync(CancellationToken cancellationToken)
    {
        var floor = time.GetUtcNow() - ClientEventLimits.Retention;
        return await db.ClientEvents.Where(e => e.At < floor).ExecuteDeleteAsync(cancellationToken);
    }

    public async Task<ClientEventsResponse> ListAsync(int limit, string? module, CancellationToken cancellationToken)
    {
        var floor = time.GetUtcNow() - ClientEventLimits.Retention;
        var query = db.ClientEvents.AsNoTracking().Where(e => e.At >= floor);
        if (module is not null)
        {
            query = query.Where(e => e.Module == module);
        }

        var rows = await query
            .OrderByDescending(e => e.At).ThenByDescending(e => e.Id)
            .Take(limit)
            .Select(e => new ClientEventRow(
                e.Id, e.UserId, e.At, e.Kind, e.Module, e.Code, e.Status, e.TraceId, e.Transport, e.Visibility, e.Route, e.Api, e.Version, e.Grace))
            .ToListAsync(cancellationToken);
        return new ClientEventsResponse(ClientEventLimits.RetentionDays, rows);
    }
}

internal sealed record ClientEventRow(
    Guid Id,
    Guid UserId,
    DateTimeOffset At,
    string Kind,
    string Module,
    string? Code,
    int? Status,
    string? TraceId,
    string? Transport,
    string Visibility,
    string Route,
    string? Api,
    string? Version,
    bool Grace);

/// <summary>As ocorrências do app como o dono as vê, das mais novas para as mais velhas. <c>RetentionDays</c> diz por quanto tempo ficam.</summary>
internal sealed record ClientEventsResponse(int RetentionDays, IReadOnlyList<ClientEventRow> Items);

/// <summary>A política de quem pode mandar a telemetria: qualquer conta ativa, dona ou convidada (o app do convidado também falha).</summary>
internal static class ClientEventPolicies
{
    public const string Report = "devices:client-events-report";

    public static void ConfigureReport(AuthorizationPolicyBuilder policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        policy.RequireAccountRole(AccountRoles.Owner, AccountRoles.Guest).RequireActiveAccount();
    }
}

internal static class ClientEventsEndpoints
{
    public const int DefaultLimit = 50;
    public const int MaxLimit = 100;

    private static readonly HashSet<string> Modules = new(StringComparer.Ordinal) { "tv", "pc", "training", "app" };

    public static void MapClientEventsReport(this IEndpointRouteBuilder group) =>
        group.MapPost("/client-events", ReportAsync)
            .RequireAuthorization(ClientEventPolicies.Report)
            .RequireRateLimiting(RateLimitPolicies.ClientEvents)
            .WithMetadata(new RequestSizeLimitAttribute(ClientEventLimits.MaxBodyBytes))
            .Accepts<ClientEventsBody>("application/json")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status413PayloadTooLarge)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    public static void MapClientEventsList(this IEndpointRouteBuilder group) =>
        group.MapGet("/client-events", ListAsync)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<ClientEventsResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static async Task<IResult> ReportAsync(
        [FromBody] ClientEventsBody? body, ICurrentUser current, ClientEventStore store, CancellationToken cancellationToken)
    {
        // A conta vem da sessão autenticada, nunca do corpo: o aparelho não diz quem é.
        if (current.UserId is not { } userId)
        {
            return TypedResults.Unauthorized();
        }

        if (body?.Events is not { Count: > 0 } events || events.Count > ClientEventLimits.MaxPerBatch)
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["events"] = [$"Mande de 1 a {ClientEventLimits.MaxPerBatch} ocorrências."],
            });
        }

        // O que não tem a forma esperada é descartado em silêncio: quem manda não aprende o formato por tentativa e erro.
        await store.RecordAsync(userId, events, cancellationToken);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> ListAsync(
        int? limit, string? module, HttpContext http, ClientEventStore store, CancellationToken cancellationToken)
    {
        var wanted = limit ?? DefaultLimit;
        var errors = new Dictionary<string, string[]>();
        if (wanted is < 1 or > MaxLimit)
        {
            errors["limit"] = [$"Peça entre 1 e {MaxLimit} ocorrências."];
        }

        if (module is not null && !Modules.Contains(module))
        {
            errors["module"] = ["Use tv, pc, training ou app."];
        }

        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        // Pistas sobre o uso do app, só do dono: nada em cache de navegador nem de proxy.
        http.Response.Headers.CacheControl = "no-store";
        return TypedResults.Ok(await store.ListAsync(wanted, module, cancellationToken));
    }
}
