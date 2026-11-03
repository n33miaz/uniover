namespace UniOver.Modules.Identity.Domain;

/// <summary>
/// Aviso de que uma métrica de capacidade passou do limite vermelho. Há no máximo UM aberto por métrica (índice único
/// parcial): ele fecha sozinho quando a métrica volta abaixo do limite (ou quando o mês vira, no caso das horas).
/// </summary>
public sealed class CapacityAlert
{
    public Guid Id { get; set; }

    /// <summary>Qual métrica: <c>database</c>, <c>memory</c> ou <c>hours</c>.</summary>
    public string Metric { get; set; } = string.Empty;

    /// <summary>Quanto do limite estava em uso quando o aviso abriu, em pontos percentuais inteiros.</summary>
    public int Percent { get; set; }

    public DateTimeOffset DetectedAt { get; set; }

    /// <summary>Preenchido quando a métrica voltou ao normal.</summary>
    public DateTimeOffset? RecoveredAt { get; set; }

    /// <summary>Preenchido quando o dono dispensou o aviso.</summary>
    public DateTimeOffset? SeenAt { get; set; }
}
