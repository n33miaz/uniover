using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Npgsql;

namespace UniOver.BuildingBlocks.Persistence;

/// <summary>
/// Loja de chaves de idempotência em Postgres, no schema do módulo dono do <typeparamref name="TContext"/>.
/// <para>
/// Cada operação usa um contexto próprio (escopo novo), nunca o da requisição: a violação de unicidade deixa a
/// entidade rastreada no contexto que falhou, e a chave é gravada fora da transação do handler de propósito (o
/// registro "em andamento" tem de ser visível para o envio concorrente antes de o handler terminar). A
/// consequência é a janela de "o handler gravou e o processo caiu antes de concluir": o reenvio executa de novo, e
/// por isso o handler do módulo continua idempotente pelo id de negócio.
/// </para>
/// </summary>
public sealed class IdempotencyStore<TContext>(IServiceScopeFactory scopes, TimeProvider time) : IIdempotencyStore<TContext>
    where TContext : ModuleDbContext
{
    private const string UniqueViolation = "23505";

    /// <summary>Rodadas da disputa (inserir, ler o vencedor, tomar o vencido) antes de desistir de brigar.</summary>
    private const int MaxRounds = 5;

    public async Task<IdempotencyBeginResult> TryBeginAsync(
        Guid userId, Guid key, string method, string route, byte[] requestHash, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(method);
        ArgumentNullException.ThrowIfNull(route);
        ArgumentNullException.ThrowIfNull(requestHash);

        for (var round = 0; round < MaxRounds; round++)
        {
            var now = time.GetUtcNow();
            await using var scope = scopes.CreateAsyncScope();
            var context = scope.ServiceProvider.GetRequiredService<TContext>();
            var records = context.Set<IdempotencyRecord>();

            // Limpeza oportunista: quem cria uma chave nova paga a faxina das vencidas.
            await records.Where(r => r.ExpiresAt <= now).ExecuteDeleteAsync(cancellationToken);

            var record = new IdempotencyRecord
            {
                UserId = userId,
                Key = key,
                Method = method,
                Route = route,
                RequestHash = requestHash,
                Generation = Guid.NewGuid(),
                CreatedAt = now,
                ExpiresAt = now + IdempotencyLimits.Retention,
            };
            records.Add(record);

            try
            {
                await context.SaveChangesAsync(cancellationToken);
                return new IdempotencyBeginResult(IdempotencyBeginOutcome.Started, null, record.Generation);
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: UniqueViolation })
            {
                context.ChangeTracker.Clear();
            }

            var existing = await records.AsNoTracking()
                .FirstOrDefaultAsync(r => r.UserId == userId && r.Key == key, cancellationToken);
            if (existing is null)
            {
                // Foi apagada (liberada ou vencida) entre o insert e a leitura: tenta de novo.
                continue;
            }

            if (existing.CompletedAt is not null)
            {
                return new IdempotencyBeginResult(IdempotencyBeginOutcome.Completed, existing);
            }

            if (!SameFingerprint(existing, method, route, requestHash))
            {
                return new IdempotencyBeginResult(IdempotencyBeginOutcome.InProgress, existing);
            }

            if (existing.CreatedAt > now - IdempotencyLimits.InProgressTimeout)
            {
                return new IdempotencyBeginResult(IdempotencyBeginOutcome.InProgress, existing);
            }

            // "Em andamento" parado: o processo que a abriu caiu. Tomar a chave é uma atualização condicional (só
            // vence quem encontrar a geração ainda intacta); ler e depois gravar deixaria dois envios vencerem.
            var generation = Guid.NewGuid();
            var taken = await records
                .Where(r => r.UserId == userId && r.Key == key && r.CompletedAt == null && r.Generation == existing.Generation)
                .ExecuteUpdateAsync(
                    s => s
                        .SetProperty(r => r.Generation, generation)
                        .SetProperty(r => r.CreatedAt, now)
                        .SetProperty(r => r.ExpiresAt, now + IdempotencyLimits.Retention),
                    cancellationToken);
            if (taken == 1)
            {
                return new IdempotencyBeginResult(IdempotencyBeginOutcome.Started, null, generation);
            }
        }

        // Disputa que não assenta (a linha some e volta sem parar): quem chama deve esperar e tentar de novo.
        return new IdempotencyBeginResult(IdempotencyBeginOutcome.InProgress, null);
    }

    public async Task CompleteAsync(
        Guid userId, Guid key, Guid leaseId, int statusCode, string? responseBody, string? contentType, string? location, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        await using var scope = scopes.CreateAsyncScope();
        var records = scope.ServiceProvider.GetRequiredService<TContext>().Set<IdempotencyRecord>();

        await records
            .Where(r => r.UserId == userId && r.Key == key && r.Generation == leaseId && r.CompletedAt == null)
            .ExecuteUpdateAsync(
                s => s
                    .SetProperty(r => r.StatusCode, statusCode)
                    .SetProperty(r => r.ResponseBody, responseBody)
                    .SetProperty(r => r.ContentType, contentType)
                    .SetProperty(r => r.Location, location)
                    .SetProperty(r => r.CompletedAt, now),
                cancellationToken);
    }

    public async Task ReleaseAsync(Guid userId, Guid key, Guid leaseId, CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var records = scope.ServiceProvider.GetRequiredService<TContext>().Set<IdempotencyRecord>();

        await records
            .Where(r => r.UserId == userId && r.Key == key && r.Generation == leaseId && r.CompletedAt == null)
            .ExecuteDeleteAsync(cancellationToken);
    }

    private static bool SameFingerprint(IdempotencyRecord record, string method, string route, byte[] requestHash) =>
        string.Equals(record.Method, method, StringComparison.Ordinal)
        && string.Equals(record.Route, route, StringComparison.Ordinal)
        && CryptographicOperations.FixedTimeEquals(record.RequestHash, requestHash);
}

public static class IdempotencyServiceCollectionExtensions
{
    /// <summary>
    /// Registra a loja de chaves do módulo dono do <typeparamref name="TContext"/> (que precisa ter chamado
    /// <c>modelBuilder.AddIdempotency()</c>).
    /// </summary>
    public static IServiceCollection AddIdempotencyStore<TContext>(this IServiceCollection services)
        where TContext : ModuleDbContext
    {
        ArgumentNullException.ThrowIfNull(services);

        services.TryAddSingleton(TimeProvider.System);
        services.TryAddScoped<IIdempotencyStore<TContext>, IdempotencyStore<TContext>>();
        return services;
    }
}
