using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Shopping.Domain;
using UniOver.Modules.Shopping.Infrastructure;
using UniOver.Modules.Shopping.Persistence;

namespace UniOver.Modules.Shopping.Features;

/// <summary>Por que o conselho não veio: desligado, buscando (o Economize acorda devagar), chave recusada ou fora do ar.</summary>
internal static class EconomizeReasons
{
    public const string Disabled = "disabled";
    public const string Waking = "waking";
    public const string Unauthorized = "unauthorized";
    public const string Unavailable = "unavailable";
    public const string MembershipChanged = "membership_changed";
}

/// <summary>Quanto está livre até o salário, em centavos, como o Economize calcula. <c>FreeCents</c> nulo: não sabe.</summary>
internal sealed record EconomizeFreeResponse(
    bool SalaryKnown,
    DateOnly? SalaryDate,
    int? DaysUntilSalary,
    long? ExpectedSalaryCents,
    long? CommittedBeforeSalaryCents,
    long? CommittedAfterSalaryCents,
    long? FreeCents);

/// <summary>
/// O conselho do Economize para a ida ao mercado. Sem <c>Available</c>, <c>Reason</c> diz por quê. <c>GeneratedAt</c> é
/// quando o Economize o calculou (a resposta pode ter até dez minutos).
/// </summary>
internal sealed record EconomizeAdviceResponse(
    bool Available,
    string? Reason,
    DateTimeOffset? GeneratedAt,
    string? Status,
    DateOnly? BestDay,
    string? BestDayWeekday,
    EconomizeFreeResponse? Free)
{
    public static EconomizeAdviceResponse Missing(string reason) => new(false, reason, null, null, null, null, null);

    public static EconomizeAdviceResponse From(EconomizeAdvice advice) =>
        new(
            true,
            null,
            advice.GeneratedAt,
            advice.Status,
            advice.BestDay,
            advice.BestDayWeekday,
            advice.Free is { } free
                ? new EconomizeFreeResponse(
                    free.SalaryKnown,
                    free.SalaryDate,
                    free.DaysUntilSalary,
                    free.ExpectedSalaryCents,
                    free.CommittedBeforeSalaryCents,
                    free.CommittedAfterSalaryCents,
                    free.FreeCents)
                : null);
}

/// <summary>
/// A importação das compras do Economize no grupo de quem chama. <c>Imported</c>: compras novas; <c>Existing</c>: já
/// trazidas antes; <c>Ignored</c>: abertas, de outra pessoa da casa ou ilegíveis. <c>Error</c> só quando parou antes do fim.
/// </summary>
internal sealed record EconomizeImportStatusResponse(bool Running, bool Finished, int Imported, int Existing, int Ignored, string? Error)
{
    public static readonly EconomizeImportStatusResponse Idle = new(false, false, 0, 0, 0, null);
}

/// <summary>
/// O conselho guardado em memória. Quem pede recebe na hora o que há (ou "buscando"); se o guardado tem mais de dez minutos,
/// UMA busca sai em segundo plano, com o ETag da última resposta (o Economize responde 304 quando nada mudou). Não há
/// laço nem temporizador: sem pedidos, nada é buscado e nenhum banco acorda.
/// </summary>
internal sealed partial class EconomizeAdviceCache(
    IEconomizeClient client,
    IOptions<ShoppingModuleOptions> options,
    TimeProvider time,
    IHostApplicationLifetime lifetime,
    ILogger<EconomizeAdviceCache> logger)
{
    public static readonly TimeSpan Refresh = TimeSpan.FromMinutes(10);

    private readonly Lock _sync = new();
    private Entry? _entry;
    private Task? _refresh;

    public EconomizeAdviceResponse Get()
    {
        if (!options.Value.Economize.IsActive)
        {
            return EconomizeAdviceResponse.Missing(EconomizeReasons.Disabled);
        }

        lock (_sync)
        {
            var stale = _entry is null || time.GetUtcNow() - _entry.CheckedAt >= Refresh;
            if (stale && (_refresh is null || _refresh.IsCompleted) && !lifetime.ApplicationStopping.IsCancellationRequested)
            {
                var etag = _entry?.Etag;
                _refresh = Task.Run(() => RefreshAsync(etag, lifetime.ApplicationStopping));
            }

            return _entry?.Response ?? EconomizeAdviceResponse.Missing(EconomizeReasons.Waking);
        }
    }

    private async Task RefreshAsync(string? etag, CancellationToken stopping)
    {
        EconomizeAdviceFetch fetched;
        try
        {
            fetched = await client.GetAdviceAsync(etag, stopping);
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested)
        {
            return;
        }
        catch (Exception ex)
        {
            LogFailed(logger, ex.GetType().Name);
            fetched = new EconomizeAdviceFetch(EconomizeFetchStatus.Unavailable);
        }

        lock (_sync)
        {
            // Sempre fica uma entrada, mesmo de falha: é o que segura a próxima busca por dez minutos.
            var old = _entry;
            var response = fetched.Status switch
            {
                EconomizeFetchStatus.Available when fetched.Advice is { } advice => EconomizeAdviceResponse.From(advice),
                EconomizeFetchStatus.NotModified when old is { Response.Available: true } => old.Response,
                EconomizeFetchStatus.Disabled => EconomizeAdviceResponse.Missing(EconomizeReasons.Disabled),
                EconomizeFetchStatus.Unauthorized => EconomizeAdviceResponse.Missing(EconomizeReasons.Unauthorized),
                _ => EconomizeAdviceResponse.Missing(EconomizeReasons.Unavailable),
            };
            var keptEtag = fetched.Status switch
            {
                EconomizeFetchStatus.Available => fetched.Etag,
                EconomizeFetchStatus.NotModified when old is { Response.Available: true } => old.Etag,
                _ => null,
            };
            _entry = new Entry(time.GetUtcNow(), keptEtag, response);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Leitura do conselho do Economize falhou ({ErrorType}).")]
    private static partial void LogFailed(ILogger logger, string errorType);

    private sealed record Entry(DateTimeOffset CheckedAt, string? Etag, EconomizeAdviceResponse Response);
}

/// <summary>
/// Lê o histórico do Economize página a página (200 por vez, no ritmo do <see cref="EconomizeThrottle"/>) e grava as
/// compras fechadas do dono da chave como compras fechadas do grupo. Cada página é uma transação com o grupo travado,
/// como as escritas do aparelho; a referência externa única por grupo faz rodar de novo não duplicar nada.
/// </summary>
internal sealed partial class EconomizeImportRunner(IEconomizeClient client, ShoppingDbContext db, TimeProvider time, ILogger<EconomizeImportRunner> logger)
{
    public const int PageSize = 200;

    /// <summary>Quantas vezes uma página recusada por excesso de pedidos (429) é tentada de novo, e a espera máxima.</summary>
    public const int RateLimitRetries = 3;

    public static readonly TimeSpan MaxRetryAfter = TimeSpan.FromSeconds(60);

    /// <summary>O Economize marca a compra conciliada com o extrato como RECONCILED: continua sendo uma compra fechada.</summary>
    private static readonly HashSet<string> FinishedStatuses = new(StringComparer.OrdinalIgnoreCase) { "CLOSED", "RECONCILED" };

    /// <summary>
    /// Uma compra que ficou aberta no Economize, com itens e parada há mais que isto, é uma compra que acabou sem que
    /// alguém tocasse em "fechar": entra como compra fechada, na hora da última mudança.
    /// </summary>
    public static readonly TimeSpan StaleOpenTrip = TimeSpan.FromDays(3);

    private static readonly JsonSerializerOptions PayloadJson = new(JsonSerializerDefaults.Web);

    public async Task RunAsync(Guid groupId, Guid userId, EconomizeImportJob job, CancellationToken cancellationToken)
    {
        string? cursor = null;
        var trail = new EconomizeCursorTrail();
        while (true)
        {
            var fetched = await FetchAsync(cursor, cancellationToken);
            if (fetched.Status != EconomizeFetchStatus.Available || fetched.Page is not { } page)
            {
                job.Fail(fetched.Status switch
                {
                    EconomizeFetchStatus.Disabled => EconomizeReasons.Disabled,
                    EconomizeFetchStatus.Unauthorized => EconomizeReasons.Unauthorized,
                    _ => EconomizeReasons.Unavailable,
                });
                return;
            }

            var counts = await SaveAsync(groupId, userId, page.Trips, cancellationToken);
            if (counts is null)
            {
                job.Fail(EconomizeReasons.MembershipChanged);
                return;
            }

            job.Add(counts.Value.Imported, counts.Value.Existing, counts.Value.Ignored);
            if (!page.HasMore || string.IsNullOrEmpty(page.NextCursor))
            {
                return;
            }

            // Um cursor que volta (A → B → A) ou páginas sem fim manteriam o banco e o Economize acordados: a importação
            // para com erro. O log não leva o cursor.
            if (!trail.TryAdvance(page.NextCursor))
            {
                LogEndlessPaging(logger, trail.Pages);
                job.Fail(EconomizeReasons.Unavailable);
                return;
            }

            cursor = page.NextCursor;
        }
    }

    private async Task<EconomizeTripsFetch> FetchAsync(string? cursor, CancellationToken cancellationToken)
    {
        for (var attempt = 0; ; attempt++)
        {
            var fetched = await client.GetTripsAsync(cursor, PageSize, cancellationToken);
            if (fetched.Status != EconomizeFetchStatus.RateLimited || attempt >= RateLimitRetries)
            {
                return fetched;
            }

            var wait = fetched.RetryAfter is { } after && after > TimeSpan.Zero && after < MaxRetryAfter ? after : MaxRetryAfter;
            await Task.Delay(wait, time, cancellationToken);
        }
    }

    /// <summary>
    /// Grava uma página (da busca no Economize ou de um arquivo exportado de lá). Nulo quando quem pediu já não está no
    /// grupo (a importação para).
    /// </summary>
    public async Task<(int Imported, int Existing, int Ignored)?> SaveAsync(
        Guid groupId, Guid userId, IReadOnlyList<EconomizeTrip> trips, CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        await db.Database.ExecuteSqlAsync($"""SELECT 1 FROM "shopping"."groups" WHERE id = {groupId} FOR UPDATE""", cancellationToken);

        // Relido com o grupo travado, como nas escritas do aparelho: quem saiu do grupo não grava mais nele.
        if (!await db.Members.AnyAsync(x => x.GroupId == groupId && x.UserId == userId && x.DeletedAt == null, cancellationToken))
        {
            return null;
        }

        var now = time.GetUtcNow();
        var candidates = new List<(EconomizeTrip Trip, string Ref, decimal Total, DateTimeOffset ClosedAt)>();
        var ignored = 0;
        foreach (var trip in trips)
        {
            if (Candidate(trip, now) is { } accepted)
            {
                candidates.Add((trip, trip.Id.ToString(), accepted.Total, accepted.ClosedAt));
            }
            else
            {
                ignored++;
            }
        }

        var refs = candidates.Select(x => x.Ref).ToList();
        var known = (await db.Purchases.AsNoTracking()
            .Where(x => x.GroupId == groupId && x.ExternalRef != null && refs.Contains(x.ExternalRef))
            .Select(x => x.ExternalRef!)
            .ToListAsync(cancellationToken)).ToHashSet(StringComparer.Ordinal);

        // Os produtos do grupo com os nomes desta página, numa consulta só. O produto é achado pelo nome normalizado, a
        // mesma chave da junção de itens repetidos: "Açúcar" do Economize cai no "acucar" que o grupo já tem.
        // A mesma compra duas vezes na página (ou no arquivo) monta as linhas uma vez; a repetida conta como já trazida.
        var lines = candidates.Where(x => !known.Contains(x.Ref)).DistinctBy(x => x.Ref, StringComparer.Ordinal)
            .ToDictionary(x => x.Ref, x => Lines(x.Trip), StringComparer.Ordinal);
        var names = lines.Values.SelectMany(x => x).Select(x => x.Normalized).Distinct(StringComparer.Ordinal).ToList();
        var products = await db.Products
            .Where(x => x.GroupId == groupId && x.DeletedAt == null && names.Contains(x.NormalizedName))
            .ToDictionaryAsync(x => x.NormalizedName, StringComparer.Ordinal, cancellationToken);

        var imported = 0;
        var existing = 0;
        foreach (var (trip, reference, total, closedAt) in candidates)
        {
            if (!known.Add(reference))
            {
                existing++;
                continue;
            }

            var operationId = Guid.CreateVersion7();
            var changes = new List<(string EntityType, Guid EntityId, object Payload)>();
            var purchase = new ShoppingPurchase
            {
                Id = Guid.CreateVersion7(),
                GroupId = groupId,
                ExternalRef = reference,
                Status = ShoppingPurchase.Closed,
                TotalPaid = total,
                Store = Cut(ShoppingRules.Clean(trip.StoreName), ShoppingLimits.Store),
                ReceiptKey = ShoppingRules.Clean(trip.ReceiptKey) is { } key && ShoppingRules.Fits(key, ShoppingLimits.ReceiptKey) ? key : null,
                StartedAt = trip.StartedAt.ToUniversalTime(),
                ClosedAt = closedAt,
                UpdatedAt = now,
            };
            db.Purchases.Add(purchase);
            changes.Add((ChangeTypes.Purchase, purchase.Id, purchase.ToResponse()));

            foreach (var line in lines[reference])
            {
                if (!products.TryGetValue(line.Normalized, out var product))
                {
                    product = new Product
                    {
                        Id = Guid.CreateVersion7(),
                        GroupId = groupId,
                        Name = line.Name,
                        NormalizedName = line.Normalized,
                        Section = string.Empty,
                        CreatedAt = now,
                        UpdatedAt = now,
                    };
                    db.Products.Add(product);
                    products[line.Normalized] = product;
                    changes.Add((ChangeTypes.Product, product.Id, product.ToResponse()));
                }

                var item = new PurchaseItem
                {
                    Id = Guid.CreateVersion7(),
                    PurchaseId = purchase.Id,
                    ProductId = product.Id,
                    Quantity = line.Quantity,
                    UnitPrice = line.UnitPrice,
                    Picked = true,
                    PricedAt = closedAt,
                    CreatedAt = line.CreatedAt ?? purchase.StartedAt,
                    UpdatedAt = now,
                };
                db.PurchaseItems.Add(item);
                changes.Add((ChangeTypes.PurchaseItem, item.Id, item.ToResponse()));
            }

            // Uma operação por compra, com as linhas do feed na ordem em que o aparelho precisa delas (o produto antes da
            // linha que o usa): os outros aparelhos do grupo recebem a compra trazida como receberiam uma feita aqui.
            db.Operations.Add(new ShoppingOperation { Id = operationId, GroupId = groupId, ActorUserId = userId, AppliedAt = now });
            foreach (var (entityType, entityId, payload) in changes.OrderBy(x => x.EntityType == ChangeTypes.Product ? 0 : 1))
            {
                db.Changes.Add(new ShoppingChange
                {
                    GroupId = groupId,
                    OperationId = operationId,
                    EntityType = entityType,
                    EntityId = entityId,
                    Payload = JsonSerializer.Serialize(payload, payload.GetType(), PayloadJson),
                    OccurredAt = now,
                });
            }

            imported++;
        }

        if (imported > 0)
        {
            await db.SaveChangesAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
        db.ChangeTracker.Clear();
        if (imported > 0)
        {
            LogPage(logger, imported, existing, ignored);
        }

        return (imported, existing, ignored);
    }

    /// <summary>
    /// Se a compra entra, com o total e a hora de fechamento. Só as do dono da chave: as fechadas (CLOSED, ou RECONCILED,
    /// a fechada que o Economize já conciliou com o extrato) e as abertas com itens paradas há mais de três dias (fecham na
    /// hora da última mudança). O total é o pago; sem ele, o da nota; sem ela, o dos itens; sem nenhum, a soma das
    /// linhas pegas.
    /// </summary>
    private static (decimal Total, DateTimeOffset ClosedAt)? Candidate(EconomizeTrip trip, DateTimeOffset now)
    {
        if (!trip.Own || !EconomizeTripLimits.IsSane(trip, now))
        {
            return null;
        }

        DateTimeOffset closedAt;
        if (FinishedStatuses.Contains(trip.Status) && trip.ClosedAt is { } closed)
        {
            closedAt = closed;
        }
        else if (string.Equals(trip.Status, "OPEN", StringComparison.OrdinalIgnoreCase)
            && trip.Items.Count > 0
            && trip.UpdatedAt is { } updated
            && now - updated > StaleOpenTrip)
        {
            closedAt = updated;
        }
        else
        {
            return null;
        }

        var cents = trip.PaidTotalCents ?? trip.ReceiptTotalCents ?? trip.ItemsTotalCents ?? CheckedLinesCents(trip);
        if (cents is null)
        {
            return null;
        }

        var total = cents.Value / 100m;
        return ShoppingRules.IsMoney(total) ? (total, closedAt.ToUniversalTime()) : null;
    }

    /// <summary>
    /// As linhas que viram histórico de preço: só o que foi pego e tem preço ("viu e não levou" e item de lista ficam de
    /// fora). Duas linhas do mesmo produto na mesma compra viram uma: as quantidades somam e o preço é o total delas
    /// dividido pela quantidade. O valor da linha vem do total dela quando há (preço × quantidade pode diferir 1 centavo).
    /// </summary>
    private static List<Line> Lines(EconomizeTrip trip)
    {
        var lines = new Dictionary<string, (string Name, decimal Quantity, decimal Amount, DateTimeOffset? CreatedAt)>(StringComparer.Ordinal);
        foreach (var item in trip.Items)
        {
            if (!item.Checked
                || item.UnitPriceCents is not (> 0 and var cents)
                || item.Quantity is not { } quantity
                || !ShoppingRules.IsQuantity(quantity)
                || ShoppingRules.Clean(item.Name) is not { } name
                || !ShoppingRules.Fits(name, ShoppingLimits.Name))
            {
                continue;
            }

            var normalized = ProductNames.Normalize(name);
            var amount = item.LineTotalCents is > 0 and var line ? line / 100m : cents / 100m * quantity;
            var createdAt = item.CreatedAt?.ToUniversalTime();
            lines[normalized] = lines.TryGetValue(normalized, out var known)
                ? (known.Name, known.Quantity + quantity, known.Amount + amount, Earliest(known.CreatedAt, createdAt))
                : (name, quantity, amount, createdAt);
        }

        var result = new List<Line>(lines.Count);
        foreach (var (normalized, (name, quantity, amount, createdAt)) in lines)
        {
            var unitPrice = Math.Round(amount / quantity, 2, MidpointRounding.AwayFromZero);
            if (ShoppingRules.IsQuantity(quantity) && ShoppingRules.IsMoney(unitPrice))
            {
                result.Add(new Line(name, normalized, quantity, unitPrice, createdAt));
            }
        }

        return result;
    }

    /// <summary>A soma das linhas pegas; nulo se estourasse (os limites já impedem, a conta confere de novo).</summary>
    private static long? CheckedLinesCents(EconomizeTrip trip)
    {
        try
        {
            long sum = 0;
            foreach (var item in trip.Items)
            {
                if (item.Checked)
                {
                    sum = checked(sum + (item.LineTotalCents ?? 0));
                }
            }

            return sum;
        }
        catch (OverflowException)
        {
            return null;
        }
    }

    private static DateTimeOffset? Earliest(DateTimeOffset? first, DateTimeOffset? second) =>
        first is { } a && second is { } b ? (a < b ? a : b) : first ?? second;

    private static string? Cut(string? value, int max) => value is null || value.Length <= max ? value : value[..max].TrimEnd();

    [LoggerMessage(Level = LogLevel.Information, Message = "Importação do Economize: página com {Imported} compras novas, {Existing} já trazidas e {Ignored} ignoradas.")]
    private static partial void LogPage(ILogger logger, int imported, int existing, int ignored);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Importação do Economize parada: cursor repetido ou teto de páginas, depois de {Pages} páginas.")]
    private static partial void LogEndlessPaging(ILogger logger, int pages);

    private sealed record Line(string Name, string Normalized, decimal Quantity, decimal UnitPrice, DateTimeOffset? CreatedAt);
}

/// <summary>
/// Os cursores já seguidos numa importação. Não deixa seguir um cursor que já apareceu (A → B → A nunca acabaria) nem
/// passar de <see cref="MaxPages"/> páginas (200 × 200 compras).
/// </summary>
internal sealed class EconomizeCursorTrail
{
    public const int MaxPages = 200;

    private readonly HashSet<string> _seen = new(StringComparer.Ordinal);

    /// <summary>Páginas já lidas: a primeira, sem cursor, mais uma por cursor seguido.</summary>
    public int Pages { get; private set; } = 1;

    public bool TryAdvance(string next)
    {
        if (Pages >= MaxPages || !_seen.Add(next))
        {
            return false;
        }

        Pages++;
        return true;
    }
}

/// <summary>
/// O que uma compra do Economize (da busca ou do arquivo) pode trazer antes de ser gravada: datas desde 2000 até amanhã,
/// valores de 0 a R$ 1 milhão em centavos, quantidade da linha pega acima de zero e até 10 mil, textos e linhas com teto.
/// Fora disso a compra é ilegível: a busca a ignora, o arquivo é recusado.
/// </summary>
internal static class EconomizeTripLimits
{
    public static readonly DateTimeOffset MinDate = new(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);
    public static readonly TimeSpan MaxAhead = TimeSpan.FromDays(1);
    public const long MaxCents = 100_000_000;
    public const decimal MaxQuantity = 10_000m;
    public const int MaxText = 1000;
    public const int MaxStatus = 32;
    public const int MaxItems = 1000;

    public static bool IsSane(EconomizeTrip trip, DateTimeOffset now)
    {
        var latest = now + MaxAhead;
        if (trip.Status.Length > MaxStatus
            || !Text(trip.StoreName)
            || !Text(trip.ReceiptKey)
            || trip.Items.Count > MaxItems
            || !Date(trip.StartedAt, latest)
            || !Date(trip.ClosedAt, latest)
            || !Date(trip.UpdatedAt, latest)
            || !Cents(trip.PaidTotalCents)
            || !Cents(trip.ReceiptTotalCents)
            || !Cents(trip.ItemsTotalCents))
        {
            return false;
        }

        // Só a linha pega é lida (vira preço e entra na soma); a que ficou na lista não barra a compra.
        return trip.Items.All(item => !item.Checked
            || (Text(item.Name)
                && item.Quantity is null or (> 0 and <= MaxQuantity)
                && Cents(item.UnitPriceCents)
                && Cents(item.LineTotalCents)
                && Date(item.CreatedAt, latest)));
    }

    private static bool Text(string? value) => value is null || value.Length <= MaxText;

    private static bool Cents(long? value) => value is null or (>= 0 and <= MaxCents);

    private static bool Date(DateTimeOffset? value, DateTimeOffset latest) => value is not { } date || (date >= MinDate && date <= latest);
}

/// <summary>O andamento de uma importação, lido pela tela enquanto ela corre.</summary>
internal sealed class EconomizeImportJob
{
    private readonly Lock _sync = new();
    private bool _running = true;
    private int _imported;
    private int _existing;
    private int _ignored;
    private string? _error;
    private DateTimeOffset? _finishedAt;

    public bool Running
    {
        get
        {
            lock (_sync)
            {
                return _running;
            }
        }
    }

    public void Add(int imported, int existing, int ignored)
    {
        lock (_sync)
        {
            _imported += imported;
            _existing += existing;
            _ignored += ignored;
        }
    }

    public void Fail(string reason)
    {
        lock (_sync)
        {
            _error = reason;
        }
    }

    public void Finish(DateTimeOffset at)
    {
        lock (_sync)
        {
            _running = false;
            _finishedAt = at;
        }
    }

    /// <summary>Terminou antes de <paramref name="cutoff"/>: já não interessa à tela.</summary>
    public bool FinishedBefore(DateTimeOffset cutoff)
    {
        lock (_sync)
        {
            return !_running && _finishedAt <= cutoff;
        }
    }

    public EconomizeImportStatusResponse Snapshot()
    {
        lock (_sync)
        {
            return new(_running, !_running, _imported, _existing, _ignored, _error);
        }
    }
}

/// <summary>
/// Uma importação por grupo, em segundo plano. Começar de novo enquanto uma corre devolve a que já corre. O trabalho para
/// quando o servidor desliga (o token de desligamento chega ao pedido HTTP, à espera e ao banco). O resultado de uma
/// importação terminada fica <see cref="Retention"/> para a tela ler; depois some no próximo acesso (sem temporizador).
/// </summary>
internal sealed partial class EconomizeImportQueue(
    IServiceScopeFactory scopes, IHostApplicationLifetime lifetime, TimeProvider time, ILogger<EconomizeImportQueue> logger)
{
    public static readonly TimeSpan Retention = TimeSpan.FromHours(1);

    private readonly Lock _sync = new();
    private readonly Dictionary<Guid, EconomizeImportJob> _jobs = [];

    public EconomizeImportStatusResponse Get(Guid groupId)
    {
        lock (_sync)
        {
            Prune();
            return _jobs.TryGetValue(groupId, out var job) ? job.Snapshot() : EconomizeImportStatusResponse.Idle;
        }
    }

    public EconomizeImportStatusResponse Start(Guid groupId, Guid userId)
    {
        EconomizeImportJob job;
        lock (_sync)
        {
            Prune();
            if (_jobs.TryGetValue(groupId, out var running) && running.Running)
            {
                return running.Snapshot();
            }

            job = new EconomizeImportJob();
            _jobs[groupId] = job;
        }

        var stopping = lifetime.ApplicationStopping;
        _ = Task.Run(() => RunAsync(groupId, userId, job, stopping), CancellationToken.None);
        return job.Snapshot();
    }

    private async Task RunAsync(Guid groupId, Guid userId, EconomizeImportJob job, CancellationToken stopping)
    {
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<EconomizeImportRunner>().RunAsync(groupId, userId, job, stopping);
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested)
        {
            job.Fail(EconomizeReasons.Unavailable);
        }
        catch (Exception ex)
        {
            LogFailed(logger, ex.GetType().Name);
            job.Fail(EconomizeReasons.Unavailable);
        }
        finally
        {
            job.Finish(time.GetUtcNow());
        }
    }

    /// <summary>Chamado com a trava: tira as importações terminadas há mais de <see cref="Retention"/>.</summary>
    private void Prune()
    {
        var cutoff = time.GetUtcNow() - Retention;
        foreach (var (groupId, job) in _jobs)
        {
            if (job.FinishedBefore(cutoff))
            {
                _jobs.Remove(groupId);
            }
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Importação do Economize interrompida ({ErrorType}).")]
    private static partial void LogFailed(ILogger logger, string errorType);
}

internal static class EconomizeIntegrationEndpoints
{
    public const string ImportPath = "/import/economize";

    /// <summary>Só o administrador com o módulo: a chave do Economize é a dele, e o que ela traz é dele.</summary>
    public static void MapEconomizeIntegration(this IEndpointRouteBuilder group)
    {
        group.MapGet("/advice", (EconomizeAdviceCache cache) => TypedResults.Ok(cache.Get()))
            .RequireAuthorization(ShoppingAuth.Module, UniOverAuth.OwnerPolicy)
            .Produces<EconomizeAdviceResponse>();
        group.MapPost(ImportPath, StartAsync)
            .RequireAuthorization(ShoppingAuth.Module, UniOverAuth.OwnerPolicy)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<EconomizeImportStatusResponse>(StatusCodes.Status202Accepted);
        group.MapGet(ImportPath, StateAsync)
            .RequireAuthorization(ShoppingAuth.Module, UniOverAuth.OwnerPolicy)
            .Produces<EconomizeImportStatusResponse>();
        group.MapPost(ImportPath + "/file", ImportFileAsync)
            .RequireAuthorization(ShoppingAuth.Module, UniOverAuth.OwnerPolicy)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<EconomizeImportStatusResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status413PayloadTooLarge);
    }

    /// <summary>O arquivo exportado do Economize: até 2 MB e 500 compras, no formato da página de compras de lá.</summary>
    public const int MaxFileBytes = 2 * 1024 * 1024;

    public const int MaxFileTrips = 500;

    /// <summary>
    /// Importa um arquivo exportado do Economize (o mesmo formato da página de compras de lá) no grupo de quem chama, pela
    /// mesma rotina da busca, e responde no fim. Não fala com o Economize: serve com a integração desligada.
    /// </summary>
    private static async Task<IResult> ImportFileAsync(
        HttpRequest request,
        ICurrentUser current,
        ShoppingGroupService groups,
        EconomizeImportRunner runner,
        TimeProvider time,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return ShoppingProblems.Unauthenticated();
        }

        if (request.ContentLength > MaxFileBytes)
        {
            return TooLarge();
        }

        // Lido com teto, mesmo sem Content-Length: um corpo maior que o limite não chega inteiro à memória.
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await request.Body.ReadAsync(chunk, cancellationToken)) > 0)
        {
            if (buffer.Length + read > MaxFileBytes)
            {
                return TooLarge();
            }

            buffer.Write(chunk, 0, read);
        }

        EconomizeTripsPage? page;
        try
        {
            using var document = JsonDocument.Parse(buffer.ToArray());
            page = EconomizeMapping.ParseTrips(document.RootElement);
        }
        catch (JsonException)
        {
            page = null;
        }

        if (page is null)
        {
            return ShoppingProblems.Invalid("trips", "O arquivo não está no formato exportado pelo Economize.");
        }

        if (page.Trips.Count > MaxFileTrips)
        {
            return ShoppingProblems.Invalid("trips", $"O arquivo aceita no máximo {MaxFileTrips} compras.");
        }

        var now = time.GetUtcNow();
        if (page.Trips.Any(x => !EconomizeTripLimits.IsSane(x, now)))
        {
            return ShoppingProblems.Invalid("trips", "O arquivo tem compra com data, valor, quantidade ou texto fora do aceito.");
        }

        var groupId = (await groups.GetForUserAsync(userId, cancellationToken)).GroupId;
        var counts = await runner.SaveAsync(groupId, userId, page.Trips, cancellationToken);
        return counts is { } done
            ? TypedResults.Ok(new EconomizeImportStatusResponse(false, true, done.Imported, done.Existing, done.Ignored, null))
            : ShoppingProblems.MembershipChanged();

        static IResult TooLarge() =>
            Results.Problem(statusCode: StatusCodes.Status413PayloadTooLarge, title: "O arquivo passa de 2 MB.");
    }

    /// <summary>Começa (ou devolve a que já corre) a importação no grupo de quem chama; o grupo nunca vem do cliente.</summary>
    private static async Task<IResult> StartAsync(
        ICurrentUser current,
        ShoppingGroupService groups,
        EconomizeImportQueue queue,
        IOptions<ShoppingModuleOptions> options,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return ShoppingProblems.Unauthenticated();
        }

        if (!options.Value.Economize.IsActive)
        {
            return TypedResults.Accepted(
                $"/api/v1/{ShoppingModule.Name}{ImportPath}",
                new EconomizeImportStatusResponse(false, true, 0, 0, 0, EconomizeReasons.Disabled));
        }

        var groupId = (await groups.GetForUserAsync(userId, cancellationToken)).GroupId;
        return TypedResults.Accepted($"/api/v1/{ShoppingModule.Name}{ImportPath}", queue.Start(groupId, userId));
    }

    private static async Task<IResult> StateAsync(ICurrentUser current, ShoppingGroupService groups, EconomizeImportQueue queue, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return ShoppingProblems.Unauthenticated();
        }

        var groupId = (await groups.GetForUserAsync(userId, cancellationToken)).GroupId;
        return TypedResults.Ok(queue.Get(groupId));
    }
}
