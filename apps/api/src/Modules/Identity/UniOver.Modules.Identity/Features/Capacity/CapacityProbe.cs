using System.Diagnostics;

namespace UniOver.Modules.Identity.Features.Capacity;

/// <summary>O que o processo informa de si mesmo; nada de chamada ao provedor de hospedagem.</summary>
internal sealed record ProcessReading(long WorkingSetBytes, long HeapBytes, DateTimeOffset StartedAt);

/// <summary>Porta de leitura do processo, para os testes simularem um servidor cheio sem encher a memória.</summary>
internal interface ICapacityProbe
{
    ProcessReading Read();
}

internal sealed class ProcessCapacityProbe : ICapacityProbe
{
    public ProcessReading Read()
    {
        using var process = Process.GetCurrentProcess();
        return new ProcessReading(
            process.WorkingSet64,
            GC.GetTotalMemory(forceFullCollection: false),
            new DateTimeOffset(process.StartTime.ToUniversalTime(), TimeSpan.Zero));
    }
}

internal static class CapacityHours
{
    /// <summary>
    /// Estimativa das horas de instância do mês: dias corridos desde o dia 1 (UTC) vezes 24, como se o serviço estivesse
    /// ligado o tempo todo. Não é medida: o provedor é quem sabe; o app sempre ligado chega perto do teto.
    /// </summary>
    public static double MonthToDate(DateTimeOffset now)
    {
        var utc = now.UtcDateTime;
        var start = new DateTime(utc.Year, utc.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        return (utc - start).TotalDays * 24;
    }
}
