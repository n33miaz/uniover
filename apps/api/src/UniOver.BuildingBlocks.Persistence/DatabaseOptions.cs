namespace UniOver.BuildingBlocks.Persistence;

/// <summary>
/// Configuração do banco da aplicação. A conexão é a do pooler (papel runtime, sem DDL).
/// A conexão de migrations (papel dono) NÃO está aqui de propósito: ela só existe na esteira e na máquina do
/// dono, e a aplicação precisa subir sem ela.
/// </summary>
public sealed class DatabaseOptions
{
    public const string SectionName = "Database";

    /// <summary>Vem de <c>ConnectionStrings:Default</c>; obrigatória fora de Development e Testing.</summary>
    public string? ConnectionString { get; set; }

    /// <summary>Pool do cliente pequeno: o pooler do Neon já multiplexa e o plano gratuito tem poucas conexões.</summary>
    public int MaxPoolSize { get; set; } = 10;

    /// <summary>Folga para o compute do Neon acordar (reativa em centenas de ms após 5 min parado).</summary>
    public int ConnectionTimeoutSeconds { get; set; } = 15;

    /// <summary>
    /// Liga <c>No Reset On Close</c> do Npgsql. Fica desligado (padrão do driver) porque a documentação não o
    /// recomenda para pooler em modo transação; só ligar depois de medir no ambiente real.
    /// </summary>
    public bool NoResetOnClose { get; set; }
}
