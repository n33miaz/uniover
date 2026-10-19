namespace UniOver.Modules.Training.Ports;

/// <summary>Uma tradução de um exercício do wger, com a licença e o autor que o próprio registro declara.</summary>
internal sealed record WgerTranslation(int LanguageId, string Name, string? DescriptionHtml, int? LicenseId, string? LicenseAuthor);

/// <summary>Um exercício do wger, reduzido ao que o importador usa.</summary>
internal sealed record WgerExercise(
    string Uuid,
    IReadOnlyList<int> MuscleIds,
    IReadOnlyList<int> SecondaryMuscleIds,
    IReadOnlyList<int> EquipmentIds,
    IReadOnlyList<WgerTranslation> Translations);

/// <summary>Uma página de exercícios; <see cref="Total"/> é a contagem declarada pelo wger.</summary>
internal sealed record WgerPage(int Total, bool HasNext, IReadOnlyList<WgerExercise> Items);

/// <summary>O wger não respondeu como o esperado (rede, tempo, status ou corpo inválido).</summary>
internal sealed class WgerUnavailableException : Exception
{
    public WgerUnavailableException(string message, Exception? inner = null)
        : base(message, inner)
    {
    }
}

/// <summary>
/// Porta para o wger. O app só lê o que o servidor importa para o próprio banco: nunca depende do servidor deles em
/// produção. A implementação real é um <c>HttpClient</c> devagar e sem paralelismo; os testes usam um falso.
/// </summary>
internal interface IWgerClient
{
    /// <summary>Lê uma página. <paramref name="offset"/> é o deslocamento de itens, não de páginas.</summary>
    Task<WgerPage> GetExercisesAsync(int offset, int limit, CancellationToken cancellationToken);
}
