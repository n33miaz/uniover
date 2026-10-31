using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace UniOver.BuildingBlocks.Messaging;

/// <summary>Um evento que esgotou as tentativas. Sem o conteúdo (<c>payload</c>): o que falhou, quando e por quê, nada além.</summary>
/// <param name="Module">O módulo cuja outbox gerou o evento.</param>
/// <param name="LastError">Só o tipo da exceção do último erro, nunca a mensagem.</param>
public sealed record DeadLetterItem(
    string Module, Guid Id, string Type, DateTimeOffset OccurredAt, DateTimeOffset FailedAt, int Attempts, string? LastError);

/// <summary>Eventos mortos de todos os módulos. <c>Total</c> é o número real; <c>Items</c> traz os mais recentes.</summary>
/// <param name="UnavailableModules">Módulos cuja fila de mortos não pôde ser lida agora (banco fora do ar, tabela ausente).</param>
public sealed record DeadLetterReport(int Total, IReadOnlyList<DeadLetterItem> Items, IReadOnlyList<string> UnavailableModules);

public static partial class DeadLetterEndpoints
{
    /// <summary>Quantos eventos mortos de cada módulo a lista devolve (os mais recentes); o total conta todos.</summary>
    public const int PerModuleLimit = 50;

    /// <summary>
    /// <c>GET /api/v1/system/dead-letters</c>: os eventos que viraram dead letter, de todos os módulos com outbox. Uma falha
    /// permanente de assinante (presença, TV) tira o evento da fila e antes só deixava um aviso comum no log; aqui o dono a vê.
    /// O chamador declara a autorização (a rota é só do dono): este método só monta a leitura.
    /// </summary>
    public static RouteHandlerBuilder MapDeadLetters(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        return endpoints.MapGet("/api/v1/system/dead-letters", ReadAsync)
            .Produces<DeadLetterReport>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, Message = "Não foi possível ler os eventos mortos do módulo {Module} ({ErrorType}).")]
        public static partial void ReadFailed(ILogger logger, string module, string errorType);
    }

    private static async Task<IResult> ReadAsync(
        OutboxModuleRegistry modules, IServiceScopeFactory scopes, ILoggerFactory loggers, CancellationToken cancellationToken)
    {
        var logger = loggers.CreateLogger("UniOver.Messaging.DeadLetters");
        var items = new List<DeadLetterItem>();
        var unavailable = new List<string>();
        var total = 0;

        foreach (var module in modules.Registrations)
        {
            try
            {
                using var scope = scopes.CreateScope();
                var context = (DbContext)scope.ServiceProvider.GetRequiredService(module.ContextType);
                var set = context.Set<DeadLetter>().AsNoTracking();

                total += await set.CountAsync(cancellationToken);
                var recent = await set
                    .OrderByDescending(d => d.FailedAt)
                    .Take(PerModuleLimit)
                    .Select(d => new { d.Id, d.Type, d.OccurredAt, d.FailedAt, d.Attempts, d.LastError })
                    .ToListAsync(cancellationToken);
                items.AddRange(recent.Select(d => new DeadLetterItem(
                    module.ModuleKey, d.Id, d.Type, d.OccurredAt, d.FailedAt, d.Attempts, d.LastError)));
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
#pragma warning disable CA1031 // Um módulo fora do ar não esconde os outros: ele vai na lista de indisponíveis.
            catch (Exception ex)
#pragma warning restore CA1031
            {
                unavailable.Add(module.ModuleKey);

                // Só o tipo do erro: a mensagem do driver do banco pode citar o servidor e a conexão.
                Log.ReadFailed(logger, module.ModuleKey, ex.GetType().Name);
            }
        }

        var ordered = items.OrderByDescending(i => i.FailedAt).ToList();
        return TypedResults.Ok(new DeadLetterReport(total, ordered, unavailable));
    }
}
