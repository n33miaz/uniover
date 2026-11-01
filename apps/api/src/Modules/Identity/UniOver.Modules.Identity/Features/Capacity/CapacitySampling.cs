using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Npgsql;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Features.Capacity;

/// <summary>
/// A amostra diária da capacidade e os avisos. Entra na lista de trabalhos do serviço de retenção que já existe (o mesmo
/// despertar diário): nenhum relógio novo, então o banco gratuito não acorda a mais por causa disto.
/// </summary>
internal static class CapacitySampling
{
    public const string JobName = "identity.capacity_samples";

    /// <summary>Quantas das maiores tabelas o cartão mostra.</summary>
    public const int TopTables = 5;

    /// <summary>
    /// Grava (ou atualiza) a amostra de hoje, apaga as que passaram da retenção, e abre ou fecha os avisos. Devolve quantas
    /// linhas antigas saíram. Rodar duas vezes no mesmo dia (o serviço reinicia a cada deploy) deixa uma amostra só.
    /// </summary>
    public static async Task<long> RunAsync(
        IdentityDbContext db, ModuleDbContextRegistry modules, ICapacityProbe probe, CapacityOptions options, TimeProvider time,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(modules);
        ArgumentNullException.ThrowIfNull(probe);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(time);

        var now = time.GetUtcNow();
        var today = DateOnly.FromDateTime(now.UtcDateTime);
        var size = await DatabaseSizeReader.ReadAsync(db, [.. modules.Registrations.Select(r => r.Schema)], 1, cancellationToken);
        var reading = probe.Read();

        await db.Database.ExecuteSqlAsync(
            $"""
            INSERT INTO identity.capacity_samples (day, database_bytes, working_set_bytes, taken_at)
            VALUES ({today}, {size.DatabaseBytes}, {reading.WorkingSetBytes}, {now})
            ON CONFLICT (day) DO UPDATE
            SET database_bytes = EXCLUDED.database_bytes, working_set_bytes = EXCLUDED.working_set_bytes, taken_at = EXCLUDED.taken_at
            """,
            cancellationToken);

        var cutoff = today.AddDays(-options.RetentionDays);
        long removed = await db.Database.ExecuteSqlAsync($"DELETE FROM identity.capacity_samples WHERE day < {cutoff}", cancellationToken);
        var cutoffAt = now.AddDays(-options.RetentionDays);
        removed += await db.Database.ExecuteSqlAsync(
            $"DELETE FROM identity.capacity_alerts WHERE recovered_at IS NOT NULL AND recovered_at < {cutoffAt}", cancellationToken);

        await EvaluateAlertsAsync(
            db,
            new Dictionary<string, double>(StringComparer.Ordinal)
            {
                [CapacityMetrics.Database] = CapacityBands.PercentOf(size.DatabaseBytes, options.DatabaseLimitBytes),
                [CapacityMetrics.Memory] = CapacityBands.PercentOf(reading.WorkingSetBytes, options.MemoryLimitBytes),
                [CapacityMetrics.Hours] = CapacityBands.PercentOf(CapacityHours.MonthToDate(now), options.MonthlyHoursLimit),
            },
            now,
            cancellationToken);
        return removed;
    }

    /// <summary>
    /// Abre um aviso para cada métrica que chegou ao vermelho e ainda não tem um aberto, e fecha o de quem voltou ao normal.
    /// Sem repetição: o aviso aberto vale até a métrica baixar.
    /// </summary>
    internal static async Task EvaluateAlertsAsync(
        IdentityDbContext db, IReadOnlyDictionary<string, double> percents, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var open = await db.CapacityAlerts.Where(a => a.RecoveredAt == null).ToDictionaryAsync(a => a.Metric, cancellationToken);
        foreach (var (metric, percent) in percents)
        {
            open.TryGetValue(metric, out var alert);
            if (percent >= CapacityBands.RedPercent)
            {
                if (alert is null)
                {
                    db.CapacityAlerts.Add(new CapacityAlert
                    {
                        Id = IdGenerator.NewId(),
                        Metric = metric,
                        Percent = (int)Math.Floor(percent),
                        DetectedAt = now,
                    });
                }
            }
            else if (alert is not null)
            {
                alert.RecoveredAt = now;
            }
        }

        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // Outra instância abriu o mesmo aviso no mesmo instante (índice único parcial): ele já existe.
            db.ChangeTracker.Clear();
        }
    }
}

internal static class CapacitySamplingRegistration
{
    public static IServiceCollection AddCapacitySampling(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddSingleton<ICapacityProbe, ProcessCapacityProbe>();
        services.AddSingleton(new AuditPurgeJob(
            CapacitySampling.JobName,
            (provider, cancellationToken) => CapacitySampling.RunAsync(
                provider.GetRequiredService<IdentityDbContext>(),
                provider.GetRequiredService<ModuleDbContextRegistry>(),
                provider.GetRequiredService<ICapacityProbe>(),
                provider.GetRequiredService<IOptions<IdentityModuleOptions>>().Value.Capacity,
                provider.GetRequiredService<TimeProvider>(),
                cancellationToken)));
        return services;
    }
}
