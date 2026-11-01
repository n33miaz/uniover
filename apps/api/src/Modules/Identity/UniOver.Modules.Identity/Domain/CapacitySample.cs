namespace UniOver.Modules.Identity.Domain;

/// <summary>
/// Uma amostra por dia (UTC) do tamanho do banco, para a tendência de crescimento. A data é a chave: a limpeza diária
/// roda de novo a cada partida do serviço, e duas amostras no mesmo dia tortariam a reta.
/// </summary>
public sealed class CapacitySample
{
    public DateOnly Day { get; set; }

    public long DatabaseBytes { get; set; }

    /// <summary>Memória do processo no instante da amostra; só informativa (nulo se não foi lida).</summary>
    public long? WorkingSetBytes { get; set; }

    public DateTimeOffset TakenAt { get; set; }
}
