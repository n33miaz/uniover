namespace UniOver.Modules.Training.Domain;

/// <summary>
/// O Postgres guarda instantes com precisão de microssegundo e o .NET com 100 ns. Gravar já truncado evita que o valor
/// lido do banco seja diferente do que o servidor tinha em memória (e que o cursor, montado com o valor lido, pule ou
/// repita registros).
/// </summary>
public static class TimeStamps
{
    private const long TicksPerMicrosecond = 10;

    public static DateTimeOffset ToStorage(DateTimeOffset value) =>
        new(value.UtcTicks - (value.UtcTicks % TicksPerMicrosecond), TimeSpan.Zero);
}
