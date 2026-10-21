using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace UniOver.BuildingBlocks.Persistence;

/// <summary>Quando a limpeza da auditoria roda. Os dias que cada trilha guarda NÃO estão aqui: são <see cref="AuditRetentionPolicy"/>.</summary>
public sealed class AuditPurgeOptions
{
    public const string SectionName = "AuditPurge";

    /// <summary>
    /// Espera depois da partida antes da primeira limpeza. Longa de propósito: a partida já acorda o banco (outbox, seed
    /// do dono) e a limpeza não deve disputar esse momento; e é curta o bastante para um serviço que o plano gratuito
    /// põe para dormir ainda limpar de vez em quando.
    /// </summary>
    public int FirstRunDelayMinutes { get; set; } = 10;

    /// <summary>
    /// Intervalo entre limpezas. Um dia: a retenção é medida em semanas, e cada limpeza acorda o banco gratuito que
    /// dorme (um despertar por dia é o custo; um laço curto manteria o compute sempre ligado).
    /// </summary>
    public int IntervalHours { get; set; } = 24;

    public TimeSpan FirstRunDelay => TimeSpan.FromMinutes(FirstRunDelayMinutes);

    public TimeSpan Interval => TimeSpan.FromHours(IntervalHours);

    public static bool IsValid(AuditPurgeOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        return options.FirstRunDelayMinutes is > 0 and <= 24 * 60 && options.IntervalHours is > 0 and <= 24 * 30;
    }
}

/// <summary>Uma limpeza de um módulo: o nome (para o log) e o que fazer; devolve quantas linhas a função apagou.</summary>
public sealed record AuditPurgeJob(string Name, Func<IServiceProvider, CancellationToken, Task<long>> RunAsync);

/// <summary>O que uma limpeza fez. <c>Error</c> é só o tipo da exceção, nunca a mensagem (pode citar SQL ou conexão).</summary>
public sealed record AuditPurgeResult(string Name, long Removed, string? Error)
{
    public bool Succeeded => Error is null;
}

/// <summary>
/// Chama, de tempos em tempos, as funções de retenção que o banco guarda (uma por schema). A aplicação NÃO apaga
/// linha de auditoria: não tem permissão de <c>DELETE</c>; a função roda com os direitos do dono, tem um piso de
/// retenção que a aplicação não consegue baixar, e este serviço só a chama com o prazo da política.
/// <para>
/// Sem polling curto e sem rodar na partida (veja <see cref="AuditPurgeOptions"/>). Uma falha (banco dormindo,
/// migration ainda não aplicada) vira aviso no log e a próxima tentativa é a do intervalo seguinte: nada derruba o serviço.
/// </para>
/// </summary>
public sealed partial class AuditPurgeService(
    IServiceScopeFactory scopes,
    IEnumerable<AuditPurgeJob> jobs,
    IOptions<AuditPurgeOptions> options,
    TimeProvider time,
    ILogger<AuditPurgeService> logger) : BackgroundService
{
    private readonly IReadOnlyList<AuditPurgeJob> _jobs = [.. jobs];

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (_jobs.Count == 0)
        {
            return;
        }

        var settings = options.Value;
        try
        {
            await Task.Delay(settings.FirstRunDelay, time, stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
            {
                await RunOnceAsync(stoppingToken);
                await Task.Delay(settings.Interval, time, stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Parada normal do serviço.
        }
    }

    /// <summary>Roda todas as limpezas uma vez, cada uma no seu escopo. Público para os testes (e para um futuro comando manual).</summary>
    public async Task<IReadOnlyList<AuditPurgeResult>> RunOnceAsync(CancellationToken cancellationToken)
    {
        var results = new List<AuditPurgeResult>(_jobs.Count);
        foreach (var job in _jobs)
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                var removed = await job.RunAsync(scope.ServiceProvider, cancellationToken);
                results.Add(new AuditPurgeResult(job.Name, removed, null));
                if (removed > 0)
                {
                    LogPurged(job.Name, removed);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
#pragma warning disable CA1031 // Uma limpeza que falha nunca derruba o serviço nem impede as outras: vira aviso.
            catch (Exception ex)
#pragma warning restore CA1031
            {
                results.Add(new AuditPurgeResult(job.Name, 0, ex.GetType().Name));
                LogFailed(job.Name, ex.GetType().Name);
            }
        }

        return results;
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Retenção da auditoria ({Job}): {Removed} linha(s) vencida(s) apagada(s).")]
    private partial void LogPurged(string job, long removed);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Retenção da auditoria ({Job}) não executada ({ErrorType}). Nova tentativa no próximo intervalo.")]
    private partial void LogFailed(string job, string errorType);
}

public static class AuditPurgeExtensions
{
    /// <summary>
    /// Registra a limpeza de um módulo: chama a função <c>schema.function(integer)</c> do banco com
    /// <paramref name="retainDays"/>. A função (criada por migration) é quem decide o que apagar e nunca apaga abaixo do
    /// próprio piso. O serviço em segundo plano é único e atende a todos os módulos.
    /// </summary>
    public static IServiceCollection AddAuditPurge<TContext>(
        this IServiceCollection services, IConfiguration configuration, string schema, string function, int retainDays)
        where TContext : DbContext
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);
        SchemaName.EnsureValid(schema);
        SchemaName.EnsureValid(function, "function");
        ArgumentOutOfRangeException.ThrowIfLessThan(retainDays, 1);

        services.AddOptions<AuditPurgeOptions>()
            .Bind(configuration.GetSection(AuditPurgeOptions.SectionName))
            .Validate(AuditPurgeOptions.IsValid, "AuditPurge tem valor fora do permitido (tempos devem ser positivos e razoáveis).")
            .ValidateOnStart();

        // Os identificadores acima passaram pela validação restrita (minúsculas, dígitos e sublinhado): é o único texto
        // que entra no SQL; o prazo vai como parâmetro.
        var sql = string.Create(CultureInfo.InvariantCulture, $"SELECT \"{schema}\".\"{function}\"({{0}}) AS \"Value\"");
        services.AddSingleton(new AuditPurgeJob(
            $"{schema}.{function}",
            async (provider, cancellationToken) =>
            {
                var db = provider.GetRequiredService<TContext>();
                await WarnIfNotAppendOnlyAsync(db, schema, provider.GetRequiredService<ILoggerFactory>().CreateLogger("UniOver.Audit"), cancellationToken);
#pragma warning disable EF1002 // Só identificadores validados entram no texto; o valor segue como parâmetro.
                return await db.Database.SqlQueryRaw<long>(sql, retainDays).SingleAsync(cancellationToken);
#pragma warning restore EF1002
            }));

        if (!services.Any(d => d.ServiceType == typeof(AuditPurgeService)))
        {
            services.AddSingleton<AuditPurgeService>();
            services.AddSingleton<IHostedService>(sp => sp.GetRequiredService<AuditPurgeService>());
        }

        return services;
    }

    private static readonly Action<ILogger, string, Exception?> LogNotAppendOnly = LoggerMessage.Define<string>(
        LogLevel.Warning,
        new EventId(1, "AuditNotAppendOnly"),
        "O papel da aplicação ainda pode alterar ou apagar linhas de {Table}: a trilha só é inviolável se o papel não herdar direitos de outro (por exemplo pg_write_all_data). Confira as heranças do papel no banco.");

    /// <summary>
    /// Autoconferência barata (só catálogo, sem ler a tabela): a migration tira UPDATE e DELETE do papel, mas um direito
    /// HERDADO de outro papel (o provedor do banco pode colocar o papel num grupo) volta a dar o acesso e nenhum REVOKE
    /// direto o desfaz. Se isso acontecer, o log avisa em vez de a trilha parecer protegida sem estar.
    /// </summary>
    private static async Task WarnIfNotAppendOnlyAsync(DbContext db, string schema, ILogger logger, CancellationToken cancellationToken)
    {
        foreach (var table in AppendOnlyTables.Of(schema))
        {
            var qualified = string.Create(CultureInfo.InvariantCulture, $"\"{schema}\".\"{table}\"");
#pragma warning disable EF1002 // Texto fixo, só com nomes da lista interna; o nome qualificado segue como parâmetro.
            var writable = await db.Database
                .SqlQueryRaw<bool>(
                    "SELECT (has_table_privilege(current_user, {0}, 'UPDATE') OR has_table_privilege(current_user, {0}, 'DELETE') OR has_table_privilege(current_user, {0}, 'TRUNCATE')) AS \"Value\"",
                    qualified)
                .SingleAsync(cancellationToken);
#pragma warning restore EF1002
            if (writable)
            {
                LogNotAppendOnly(logger, qualified, null);
            }
        }
    }
}
