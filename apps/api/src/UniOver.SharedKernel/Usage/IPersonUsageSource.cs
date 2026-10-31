namespace UniOver.SharedKernel.Usage;

/// <summary>Quantas vezes algo aconteceu nos últimos 7 e 30 dias.</summary>
public sealed record UsageCount(int Last7Days, int Last30Days)
{
    public static UsageCount None { get; } = new(0, 0);
}

/// <summary>
/// Porta de LEITURA do uso por pessoa de um módulo, no mesmo desenho da <c>IAuditSource</c>: cada módulo dono do dado
/// implementa a porta no próprio interior e a registra no contêiner; o agregador do administrador consome todas as
/// registradas, sem conhecer o módulo nem a tabela. Só contagens, nunca conteúdo.
/// </summary>
public interface IPersonUsageSource
{
    /// <summary>Código estável do que se conta (por exemplo <c>tv.commands</c>, <c>training.workouts</c>).</summary>
    string Key { get; }

    /// <summary>
    /// Contagens das contas pedidas, em uma consulta. Contas sem nenhum registro ficam de fora do mapa. A janela de 7 dias
    /// vai de <paramref name="since7"/> até agora; a de 30 vai de <paramref name="since30"/> até agora.
    /// </summary>
    Task<IReadOnlyDictionary<Guid, UsageCount>> CountAsync(
        IReadOnlyCollection<Guid> userIds, DateTimeOffset since7, DateTimeOffset since30, CancellationToken cancellationToken);
}

/// <summary>Os códigos do que se conta, no SharedKernel porque quem agrega e quem fornece precisam do mesmo texto.</summary>
public static class UsageKeys
{
    public const string TvCommands = "tv.commands";
    public const string Workouts = "training.workouts";
}
