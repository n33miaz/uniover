namespace UniOver.Modules.Training.Domain;

/// <summary>
/// Regra do último a escrever, por registro: o servidor aplica uma escrita só se o <c>clientUpdatedAt</c> dela não for
/// mais velho que o guardado. Escrita mais velha não é erro (200 com o registro guardado). A lápide segue a mesma
/// regra, então uma lápide mais nova vence uma edição mais velha.
/// </summary>
public static class LastWriterWins
{
    /// <summary>Quanto o relógio do aparelho pode estar à frente do servidor antes de a escrita ser recusada.</summary>
    public static readonly TimeSpan MaxClockAhead = TimeSpan.FromHours(24);

    /// <summary>Empate aplica de novo (o reenvio idempotente do mesmo registro cai aqui).</summary>
    public static bool ShouldApply(DateTimeOffset incoming, DateTimeOffset stored) => incoming >= stored;

    /// <summary>
    /// Relógio do aparelho absurdamente à frente (por exemplo, data errada no celular) venceria todas as edições futuras
    /// legítimas; por isso passar de 24 h é recusado.
    /// </summary>
    public static bool IsClockAhead(DateTimeOffset incoming, DateTimeOffset serverNow) =>
        incoming - serverNow > MaxClockAhead;
}
