namespace UniOver.SharedKernel;

/// <summary>Porta do relógio: permite testar regras que dependem de tempo sem esperar nem usar relógio global.</summary>
public interface IClock
{
    DateTimeOffset UtcNow { get; }
}

public sealed class SystemClock : IClock
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
}
