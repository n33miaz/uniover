using Microsoft.Extensions.Logging;

namespace UniOver.Modules.Tv.Tests.Support;

/// <summary>Uma linha de log como o teste a enxerga: o nível, o texto já formatado e a exceção, se alguém a passou.</summary>
internal sealed record LoggedLine(LogLevel Level, string Message, Exception? Exception);

/// <summary>
/// Guarda o que foi registrado, para provar o que NÃO pode aparecer no log: a regra do projeto é registrar só o tipo do
/// erro, nunca o objeto da exceção (a mensagem do driver do banco pode citar o servidor e a conexão).
/// </summary>
internal sealed class CapturingLogger<T> : ILogger<T>
{
    public List<LoggedLine> Lines { get; } = [];

    public IDisposable? BeginScope<TState>(TState state)
        where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        ArgumentNullException.ThrowIfNull(formatter);
        Lines.Add(new LoggedLine(logLevel, formatter(state, exception), exception));
    }

    /// <summary>Tudo que o log mostraria (texto e exceção), numa string só, para procurar o que não deveria estar lá.</summary>
    public string Everything => string.Join('\n', Lines.Select(l => $"{l.Message} {l.Exception}"));
}
