using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace UniOver.IntegrationTests.Training;

/// <summary>
/// Segura, sem <c>Sleep</c>, o pedido antes de executar o primeiro comando SQL que casa com <c>match</c>, e só o solta
/// quando o teste mandar. O ponto de parada é um comando do banco, não um tempo: assim dois
/// pedidos entram na mesma janela de corrida sempre na mesma ordem, e o teste falha sem a correção em vez de "às vezes".
///
/// Só vale depois de <see cref="Arm"/> (a preparação do teste também fala com o banco). Para provar a correção, o outro
/// pedido tem dois finais possíveis: ou termina (nada o segura, que é o que acontece sem a trava de linha) ou chega ao
/// <c>FOR UPDATE</c> e fica esperando o pedido parado (<see cref="OtherWaitsOnLock"/>). Nos dois casos o teste já pode
/// soltar o pedido parado e conferir o estado final.
/// </summary>
internal sealed class CommandBarrier(Func<string, bool> match) : DbCommandInterceptor
{
    /// <summary>Teto das esperas: um teste que trava vira falha com mensagem, não um processo pendurado.</summary>
    public static readonly TimeSpan Ceiling = TimeSpan.FromSeconds(15);

    private readonly TaskCompletionSource _reached = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _released = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _otherWaitsOnLock = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _armed;
    private int _held;
    private volatile DbConnection? _heldConnection;

    /// <summary>Um pedido chegou ao ponto de parada e está retido.</summary>
    public Task Reached => _reached.Task;

    /// <summary>Outro pedido (outra conexão) começou um <c>SELECT ... FOR UPDATE</c> depois que o primeiro ficou retido.</summary>
    public Task OtherWaitsOnLock => _otherWaitsOnLock.Task;

    public void Arm() => Volatile.Write(ref _armed, 1);

    public void Release() => _released.TrySetResult();

    public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
    {
        NoteLockAttempt(command);
        await HoldIfMatchesAsync(command, cancellationToken);

        return result;
    }

    public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        NoteLockAttempt(command);
        await HoldIfMatchesAsync(command, cancellationToken);

        return result;
    }

    private void NoteLockAttempt(DbCommand command)
    {
        if (_heldConnection is { } held
            && !ReferenceEquals(command.Connection, held)
            && command.CommandText.Contains("FOR UPDATE", StringComparison.OrdinalIgnoreCase))
        {
            _otherWaitsOnLock.TrySetResult();
        }
    }

    private async Task HoldIfMatchesAsync(DbCommand command, CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _armed) == 0 || !match(command.CommandText) || Interlocked.Exchange(ref _held, 1) != 0)
        {
            return;
        }

        _heldConnection = command.Connection;
        _reached.TrySetResult();
        await _released.Task.WaitAsync(Ceiling, cancellationToken);
    }
}

/// <summary>Faz o primeiro comando que casa falhar (enquanto armado), para provar o que o código faz quando o banco recusa.</summary>
internal sealed class FailingCommand(Func<string, bool> match) : DbCommandInterceptor
{
    private int _armed;

    public void Arm() => Volatile.Write(ref _armed, 1);

    public void Disarm() => Volatile.Write(ref _armed, 0);

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default) =>
        Volatile.Read(ref _armed) != 0 && match(command.CommandText)
            ? throw new InvalidOperationException("falha injetada pelo teste")
            : ValueTask.FromResult(result);

    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default) =>
        Volatile.Read(ref _armed) != 0 && match(command.CommandText)
            ? throw new InvalidOperationException("falha injetada pelo teste")
            : ValueTask.FromResult(result);
}

internal static class SqlCommandText
{
    /// <summary>Confere o verbo SQL, ignorando espaço e comentários que o provedor possa colocar antes do comando.</summary>
    public static bool StartsWithUpdate(string sql)
    {
        var remaining = sql.AsSpan();
        while (true)
        {
            remaining = remaining.TrimStart();
            if (remaining.StartsWith("--", StringComparison.Ordinal))
            {
                var lineEnd = remaining.IndexOfAny('\r', '\n');
                remaining = lineEnd < 0 ? ReadOnlySpan<char>.Empty : remaining[(lineEnd + 1)..];
                continue;
            }

            if (remaining.StartsWith("/*", StringComparison.Ordinal))
            {
                var commentEnd = remaining[2..].IndexOf("*/", StringComparison.Ordinal);
                if (commentEnd < 0)
                {
                    return false;
                }

                remaining = remaining[(commentEnd + 4)..];
                continue;
            }

            return remaining.StartsWith("UPDATE", StringComparison.OrdinalIgnoreCase);
        }
    }
}
