using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Features.Capacity;

internal sealed record CapacityTable(string Schema, string Name, long Bytes);

/// <summary>Tamanho do banco contra o limite do plano gratuito. O tamanho é o lógico do Postgres (estimativa do que o provedor cobra).</summary>
internal sealed record CapacityDatabase(long Bytes, long LimitBytes, double Percent, string Band, IReadOnlyList<CapacityTable> Tables);

/// <summary>
/// O servidor como o próprio processo o vê. A RAM do limite e as horas do mês são estimativas (o app não consulta o
/// provedor): <c>MonthHours</c> é dias corridos x 24 x serviços do workspace, como se tudo ficasse sempre ligado. As horas são
/// informativas (faixa <c>neutral</c>); só ficam vermelhas se <c>HoursProjected</c>, o mês inteiro, passar do limite.
/// </summary>
internal sealed record CapacityServer(
    long WorkingSetBytes, long HeapBytes, long MemoryLimitBytes, double MemoryPercent, string MemoryBand,
    DateTimeOffset StartedAt, long UptimeSeconds,
    double MonthHours, int HoursLimit, double HoursPercent, string HoursBand, double HoursProjected, int ServicesInWorkspace);

internal sealed record CapacityAlertItem(Guid Id, string Metric, int Percent, DateTimeOffset DetectedAt);

/// <summary>O cartão inteiro. <c>MeasuredAt</c> é quando o banco foi medido (pode ter alguns minutos); o servidor é lido na hora.</summary>
internal sealed record CapacityResponse(
    CapacityDatabase Database, CapacityServer Server, CapacityGrowth Growth, IReadOnlyList<CapacityAlertItem> Alerts,
    DateTimeOffset MeasuredAt);

/// <summary>
/// Junta o retrato da capacidade: banco (só catálogo), processo, tendência das amostras diárias e avisos abertos. Mora no
/// Identity porque o dono e as configurações do sistema são dele; os tamanhos vêm do catálogo do Postgres, sem ler linha de
/// outro módulo.
/// </summary>
internal sealed class CapacityHandler(
    IdentityDbContext db, ModuleDbContextRegistry modules, ICapacityProbe probe, CapacityDatabaseReading databaseReading,
    IOptions<IdentityModuleOptions> options, TimeProvider time)
{
    /// <summary>A janela da tendência, em dias.</summary>
    public const int TrendDays = 30;

    public async Task<CapacityResponse> HandleAsync(CancellationToken cancellationToken)
    {
        var capacity = options.Value.Capacity;
        var now = time.GetUtcNow();
        var today = DateOnly.FromDateTime(now.UtcDateTime);

        // A medida do banco é cara (varre o catálogo): reaproveitada por alguns minutos, com o instante em que foi feita.
        var schemas = modules.Registrations.Select(r => r.Schema).ToArray();
        var (size, databaseMeasuredAt) = await databaseReading.GetAsync(
            TimeSpan.FromMinutes(capacity.DatabaseCacheMinutes),
            token => DatabaseSizeReader.ReadAsync(db, schemas, CapacitySampling.TopTables, token),
            cancellationToken);
        var since = today.AddDays(-(TrendDays - 1));
        var samples = await db.CapacitySamples.AsNoTracking()
            .Where(s => s.Day >= since)
            .OrderBy(s => s.Day)
            .Select(s => new { s.Day, s.DatabaseBytes })
            .ToListAsync(cancellationToken);
        var alerts = await db.CapacityAlerts.AsNoTracking()
            .Where(a => a.RecoveredAt == null && a.SeenAt == null)
            .OrderByDescending(a => a.DetectedAt)
            .Select(a => new CapacityAlertItem(a.Id, a.Metric, a.Percent, a.DetectedAt))
            .ToListAsync(cancellationToken);

        var reading = probe.Read();
        var databasePercent = CapacityBands.PercentOf(size.DatabaseBytes, capacity.DatabaseLimitBytes);
        var memoryPercent = CapacityBands.PercentOf(reading.WorkingSetBytes, capacity.MemoryLimitBytes);
        var monthHours = CapacityHours.MonthToDate(now) * capacity.ServicesInWorkspace;
        var hoursPercent = CapacityBands.PercentOf(monthHours, capacity.MonthlyHoursLimit);

        return new CapacityResponse(
            new CapacityDatabase(
                size.DatabaseBytes, capacity.DatabaseLimitBytes, databasePercent, CapacityBands.Of(databasePercent),
                [.. size.LargestTables.Select(t => new CapacityTable(t.Schema, t.Name, t.Bytes))]),
            new CapacityServer(
                reading.WorkingSetBytes, reading.HeapBytes, capacity.MemoryLimitBytes, memoryPercent, CapacityBands.Of(memoryPercent),
                reading.StartedAt, (long)Math.Max(0, (now - reading.StartedAt).TotalSeconds),
                monthHours, capacity.MonthlyHoursLimit, hoursPercent, CapacityHours.Band(now, capacity),
                CapacityHours.MonthProjection(now, capacity.ServicesInWorkspace), capacity.ServicesInWorkspace),
            CapacityTrend.Compute([.. samples.Select(s => (s.Day, s.DatabaseBytes))], size.DatabaseBytes, capacity.DatabaseLimitBytes),
            alerts,
            databaseMeasuredAt);
    }

    /// <summary>
    /// O dono viu: só os avisos abertos saem do cartão. Um aviso que já fechou fica como está (nada a dispensar), e o próximo
    /// vermelho, depois de voltar ao normal e do cooldown, abre outro.
    /// </summary>
    public async Task MarkSeenAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        await db.CapacityAlerts.Where(a => a.SeenAt == null && a.RecoveredAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.SeenAt, now), cancellationToken);
    }
}

internal static class CapacityEndpoint
{
    public static void MapCapacity(this IEndpointRouteBuilder group)
    {
        // Só o dono: tamanho de tabela e memória do servidor não são assunto de convidado.
        group.MapGet("/capacity", async (CapacityHandler handler, CancellationToken cancellationToken) =>
                TypedResults.Ok(await handler.HandleAsync(cancellationToken)))
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .RequireRateLimiting(RateLimitPolicies.Capacity)
            .Produces<CapacityResponse>().ProducesProblem(401).ProducesProblem(403);

        group.MapPost("/capacity/alerts/seen", async (CapacityHandler handler, CancellationToken cancellationToken) =>
            {
                await handler.MarkSeenAsync(cancellationToken);
                return TypedResults.NoContent();
            })
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .ProducesProblem(401).ProducesProblem(403);
    }
}
