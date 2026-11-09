using Microsoft.Extensions.Logging;
using UniOver.Modules.Identity.Contracts;

namespace UniOver.Modules.Identity.Security;

/// <summary>
/// Avisa os <see cref="IUserAccessListener"/> de que o acesso de uma pessoa mudou (depois de a mudança estar gravada e fora de
/// qualquer trava). Um ouvinte que falha só vai para o registro: a sessão encerrada, a senha trocada ou a permissão retirada
/// já valem. O aviso não usa o token da requisição (cancelar a requisição depois de gravar não pode deixar o canal aberto) e
/// cada ouvinte tem o próprio prazo.
/// </summary>
internal sealed partial class UserAccessNotifier(IEnumerable<IUserAccessListener> listeners, ILogger<UserAccessNotifier> logger)
{
    public async Task NotifyAsync(UserAccessChange change)
    {
        ArgumentNullException.ThrowIfNull(change);

        foreach (var listener in listeners)
        {
            try
            {
                await listener.ChangedAsync(change, CancellationToken.None);
            }
#pragma warning disable CA1031 // O ouvinte é um efeito colateral: a falha dele nunca desfaz a mudança de acesso já gravada.
            catch (Exception ex)
#pragma warning restore CA1031
            {
                LogListenerFailed(change.Kind.ToString(), ex.GetType().Name);
            }
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Um ouvinte de mudança de acesso falhou ({Kind}, {Error}).")]
    private partial void LogListenerFailed(string kind, string error);
}
