using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Npgsql;

namespace UniOver.BuildingBlocks.Persistence;

/// <summary>Etiqueta das verificações que tocam no banco: só <c>/health/ready</c> as executa, nunca <c>/health/live</c>.</summary>
public static class HealthTags
{
    public const string Ready = "ready";
}

/// <summary>
/// Confere que o banco responde (<c>SELECT 1</c> com a conexão da aplicação). É a única verificação que acorda o compute
/// do Neon gratuito, então o resultado fica guardado por alguns segundos: um monitor, um visitante ou um laço apertado
/// pedindo <c>/health/ready</c> de novo e de novo cai todo no mesmo resultado, sem abrir uma conexão por pedido.
/// O corpo da resposta é só o status: a causa da falha (que pode citar servidor ou conexão) só vai para o log, como tipo.
/// </summary>
public sealed partial class DatabaseHealthCheck(
    IOptions<DatabaseOptions> options,
    TimeProvider time,
    ILogger<DatabaseHealthCheck> logger) : IHealthCheck
{
    /// <summary>Quanto vale um resultado saudável. Curto o bastante para a prontidão não mentir por muito tempo.</summary>
    public static readonly TimeSpan HealthyCacheLifetime = TimeSpan.FromSeconds(30);

    /// <summary>Quanto vale uma falha: bem menor, para a recuperação do banco aparecer logo.</summary>
    public static readonly TimeSpan UnhealthyCacheLifetime = TimeSpan.FromSeconds(5);

    /// <summary>Teto de espera: cobre o despertar do banco (centenas de ms) com folga e ainda responde antes do tempo do monitor (30 s).</summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(8);

    private readonly Lock _gate = new();
    private (DateTimeOffset At, bool Healthy)? _last;

    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        var now = time.GetUtcNow();
        lock (_gate)
        {
            if (_last is { } last && now - last.At < (last.Healthy ? HealthyCacheLifetime : UnhealthyCacheLifetime))
            {
                return last.Healthy ? HealthCheckResult.Healthy() : HealthCheckResult.Unhealthy();
            }
        }

        var healthy = await ProbeAsync(cancellationToken);
        lock (_gate)
        {
            _last = (time.GetUtcNow(), healthy);
        }

        return healthy ? HealthCheckResult.Healthy() : HealthCheckResult.Unhealthy();
    }

    private async Task<bool> ProbeAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Timeout);

            var connection = ModuleDatabase.BuildRuntimeConnectionString(options.Value);
            await using var db = new NpgsqlConnection(connection);
            await db.OpenAsync(timeout.Token);
            await using var command = new NpgsqlCommand("SELECT 1", db);
            await command.ExecuteScalarAsync(timeout.Token);
            return true;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
#pragma warning disable CA1031 // Qualquer falha (banco dormindo demais, rede, senha) vira "indisponível"; o motivo vai só como tipo.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogProbeFailed(ex.GetType().Name);
            return false;
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "A checagem de prontidão não alcançou o banco ({ErrorType}).")]
    private partial void LogProbeFailed(string errorType);
}

public static class DatabaseHealthCheckExtensions
{
    /// <summary>Registra a verificação do banco, etiquetada como <see cref="HealthTags.Ready"/> (fora de <c>/health/live</c>).</summary>
    public static IHealthChecksBuilder AddUniOverDatabaseCheck(this IHealthChecksBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.Services.TryAddSingleton(TimeProvider.System);
        builder.Services.AddSingleton<DatabaseHealthCheck>();
        return builder.AddCheck<DatabaseHealthCheck>("database", tags: [HealthTags.Ready]);
    }
}
