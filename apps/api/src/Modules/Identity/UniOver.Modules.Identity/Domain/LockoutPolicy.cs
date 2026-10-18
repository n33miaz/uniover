namespace UniOver.Modules.Identity.Domain;

/// <summary>
/// Bloqueio progressivo: a partir de <see cref="Threshold"/> falhas seguidas bloqueia por
/// <see cref="BaseDelay"/>, dobrando a cada falha extra até <see cref="MaxDelay"/>. O teto existe porque o
/// bloqueio é por conta: um atacante consegue travar o dono, e 15 minutos limita o estrago.
/// </summary>
public sealed record LockoutPolicy(int Threshold, TimeSpan BaseDelay, TimeSpan MaxDelay)
{
    public static LockoutPolicy Default { get; } = new(5, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(15));

    /// <summary>Tempo de bloqueio depois de <paramref name="failures"/> falhas seguidas (zero abaixo do limite).</summary>
    public TimeSpan DelayFor(int failures)
    {
        if (failures < Threshold)
        {
            return TimeSpan.Zero;
        }

        // O expoente é limitado: 2^30 já passa de qualquer teto razoável e evita estouro do double.
        var factor = Math.Pow(2, Math.Min(failures - Threshold, 30));
        var seconds = Math.Min(MaxDelay.TotalSeconds, BaseDelay.TotalSeconds * factor);
        return TimeSpan.FromSeconds(seconds);
    }
}
