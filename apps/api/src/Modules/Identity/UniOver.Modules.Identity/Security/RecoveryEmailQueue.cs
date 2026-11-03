using System.Threading.Channels;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace UniOver.Modules.Identity.Security;

/// <summary>Fila limitada em memória: a resposta pública nunca espera o provedor nem devolve o segredo.</summary>
internal sealed class RecoveryEmailQueue
{
    private readonly Channel<(string Email, string Token)> channel = Channel.CreateBounded<(string, string)>(
        new BoundedChannelOptions(100) { SingleReader = true, SingleWriter = false, FullMode = BoundedChannelFullMode.Wait });

    public bool TryQueue(string email, string token) => channel.Writer.TryWrite((email, token));

    public IAsyncEnumerable<(string Email, string Token)> ReadAllAsync(CancellationToken cancellationToken) =>
        channel.Reader.ReadAllAsync(cancellationToken);
}

/// <summary>Entrega o link fora da requisição. Uma queda perde só o envio pendente; o link nunca é persistido em claro.</summary>
internal sealed class RecoveryEmailWorker(RecoveryEmailQueue queue, IServiceScopeFactory scopes) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var (email, token) in queue.ReadAllAsync(stoppingToken))
        {
            try
            {
                using var scope = scopes.CreateScope();
                var sender = scope.ServiceProvider.GetRequiredService<IRecoveryEmailSender>();
                await sender.TrySendAsync(email, token, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception)
            {
                // Um provedor indisponível não derruba o host. Nada do item (e-mail, token) vai para o log.
            }
        }
    }
}
