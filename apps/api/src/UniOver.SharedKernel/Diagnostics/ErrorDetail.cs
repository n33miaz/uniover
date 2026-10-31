using System.Text;

namespace UniOver.SharedKernel.Diagnostics;

/// <summary>
/// O que se pode gravar de uma exceção no log: o TIPO (e o dos erros internos) e a PILHA, nunca a mensagem. A mensagem do
/// driver do banco ou de uma falha de rede cita servidor, porta e conexão, e o log vai para um painel de terceiros; a pilha
/// só tem nomes de método e de arquivo do próprio código, que é o que falta para achar a causa de um erro de produção
/// (antes só o nome do tipo ia ao log, e diagnosticar uma falha de agente ou de partida a frio era adivinhação).
/// </summary>
public static class ErrorDetail
{
    /// <summary>Teto do texto: uma pilha funda não vira linha de log de dezenas de KB.</summary>
    public const int MaxLength = 1800;

    /// <summary>Tipo (com a cadeia de erros internos) e pilha do erro, sem mensagem alguma.</summary>
    public static string Stack(Exception exception)
    {
        ArgumentNullException.ThrowIfNull(exception);

        var text = new StringBuilder(exception.GetType().Name);
        var inner = exception.InnerException;
        for (var depth = 0; inner is not null && depth < 3; depth++, inner = inner.InnerException)
        {
            text.Append(" <- ").Append(inner.GetType().Name);
        }

        if (exception.StackTrace is { Length: > 0 } stack)
        {
            text.Append(' ').Append(stack.ReplaceLineEndings(" | "));
        }

        return text.Length <= MaxLength ? text.ToString() : text.ToString(0, MaxLength) + "…";
    }
}
