using System.Globalization;

namespace UniOver.Modules.Identity.Features.Capacity;

/// <summary>Limites (<c>Modules:Identity:Capacity</c>). Os padrões são os do plano gratuito que o app usa hoje.</summary>
public sealed class CapacityOptions
{
    /// <summary>Armazenamento do banco gratuito: 1 GiB (1024 x 1024 x 1024 bytes).</summary>
    public long DatabaseLimitBytes { get; set; } = 1024L * 1024 * 1024;

    /// <summary>RAM do serviço gratuito: 512 MB. É o valor das notas do projeto, não de uma página do provedor.</summary>
    public int MemoryLimitMb { get; set; } = 512;

    /// <summary>Horas de instância grátis por mês e por workspace.</summary>
    public int MonthlyHoursLimit { get; set; } = 750;

    /// <summary>
    /// Quantos serviços sempre ligados dividem as horas do workspace (padrão 1: só a API). As horas são do workspace, então
    /// cada serviço a mais soma o mês inteiro: com 2 a projeção passa de 750 e o aviso abre.
    /// </summary>
    public int ServicesInWorkspace { get; set; } = 1;

    /// <summary>Quantos dias de amostras a limpeza guarda.</summary>
    public int RetentionDays { get; set; } = 120;

    public long MemoryLimitBytes => MemoryLimitMb * 1024L * 1024;

    internal bool IsValid() =>
        DatabaseLimitBytes >= 1 && MemoryLimitMb >= 1 && MonthlyHoursLimit >= 1 && ServicesInWorkspace is >= 1 and <= 20 && RetentionDays is >= 31 and <= 3650;
}

/// <summary>As faixas do cartão: verde abaixo de 50%, âmbar de 50% a 80%, vermelho de 80% em diante.</summary>
internal static class CapacityBands
{
    public const double AmberPercent = 50;
    public const double RedPercent = 80;

    /// <summary>Só informativo: a leitura aparece com a porcentagem, mas não vira alerta (as horas do mês).</summary>
    public const string Neutral = "neutral";

    public const string Green = "green";
    public const string Amber = "amber";
    public const string Red = "red";

    public static string Of(double percent) =>
        percent >= RedPercent ? Red : percent >= AmberPercent ? Amber : Green;

    public static double PercentOf(double used, double limit) => limit <= 0 ? 0 : used / limit * 100;
}

/// <summary>Os nomes estáveis das métricas (coluna <c>metric</c> dos avisos e campo do contrato).</summary>
internal static class CapacityMetrics
{
    public const string Database = "database";
    public const string Memory = "memory";
    public const string Hours = "hours";
}

/// <summary>Um ponto da curva de 30 dias: o dia (UTC) e o tamanho do banco naquele dia.</summary>
internal sealed record CapacityPoint(string Day, long Bytes);

/// <summary>
/// A tendência do banco. <c>BytesPerDay</c> é a inclinação da reta (mínimos quadrados) sobre as amostras da janela;
/// <c>DaysToAmber</c>/<c>DaysToRed</c> contam a partir de hoje (0 = já passou) e ficam nulos quando não há data honesta
/// (poucos dados, banco estável ou encolhendo).
/// </summary>
internal sealed record CapacityGrowth(
    IReadOnlyList<CapacityPoint> Points, double? BytesPerDay, double? DaysToAmber, double? DaysToRed, string State)
{
    public const string FewSamples = "few";
    public const string Flat = "flat";
    public const string Growing = "growing";
}

internal static class CapacityTrend
{
    /// <summary>Amostras mínimas (dias distintos) para falar em tendência.</summary>
    public const int MinimumSamples = 2;

    public static CapacityGrowth Compute(
        IReadOnlyList<(DateOnly Day, long Bytes)> samples, long currentBytes, long limitBytes)
    {
        ArgumentNullException.ThrowIfNull(samples);

        var ordered = samples.OrderBy(s => s.Day).ToList();
        var points = ordered
            .Select(s => new CapacityPoint(s.Day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), s.Bytes))
            .ToList();
        if (ordered.Count < MinimumSamples)
        {
            return new CapacityGrowth(points, null, null, null, CapacityGrowth.FewSamples);
        }

        // Reta por mínimos quadrados: x = dias desde a primeira amostra, y = bytes.
        var first = ordered[0].Day;
        var xs = ordered.Select(s => (double)(s.Day.DayNumber - first.DayNumber)).ToArray();
        var ys = ordered.Select(s => (double)s.Bytes).ToArray();
        var meanX = xs.Average();
        var meanY = ys.Average();
        var variance = xs.Sum(x => (x - meanX) * (x - meanX));
        var slope = variance <= 0 ? 0 : xs.Zip(ys, (x, y) => (x - meanX) * (y - meanY)).Sum() / variance;

        var amberBytes = limitBytes * CapacityBands.AmberPercent / 100;
        var redBytes = limitBytes * CapacityBands.RedPercent / 100;

        if (slope <= 0)
        {
            // Sem crescimento: só se já passou do limite a resposta é uma data (hoje); senão não há data.
            return new CapacityGrowth(points, slope, DaysTo(currentBytes, amberBytes, 0), DaysTo(currentBytes, redBytes, 0), CapacityGrowth.Flat);
        }

        return new CapacityGrowth(
            points, slope, DaysTo(currentBytes, amberBytes, slope), DaysTo(currentBytes, redBytes, slope), CapacityGrowth.Growing);
    }

    private static double? DaysTo(long currentBytes, double thresholdBytes, double slope)
    {
        if (currentBytes >= thresholdBytes)
        {
            return 0;
        }

        return slope <= 0 ? null : (thresholdBytes - currentBytes) / slope;
    }
}
