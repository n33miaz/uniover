namespace UniOver.Modules.Training.Domain;

/// <summary>
/// Músculos do catálogo: conjunto fechado, com ids estáveis (snake_case) que a API e o PWA compartilham. A lista segue
/// os valores que a fonte do catálogo usa; o rótulo em português é texto de tela e mora no PWA.
/// </summary>
public static class Muscle
{
    public const string Abdominals = "abdominals";
    public const string Abductors = "abductors";
    public const string Adductors = "adductors";
    public const string Biceps = "biceps";
    public const string Calves = "calves";
    public const string Chest = "chest";
    public const string Forearms = "forearms";
    public const string Glutes = "glutes";
    public const string Hamstrings = "hamstrings";
    public const string Lats = "lats";
    public const string LowerBack = "lower_back";
    public const string MiddleBack = "middle_back";
    public const string Neck = "neck";
    public const string Quadriceps = "quadriceps";
    public const string Shoulders = "shoulders";
    public const string Traps = "traps";
    public const string Triceps = "triceps";

    public static IReadOnlyList<string> All { get; } =
    [
        Abdominals, Abductors, Adductors, Biceps, Calves, Chest, Forearms, Glutes, Hamstrings,
        Lats, LowerBack, MiddleBack, Neck, Quadriceps, Shoulders, Traps, Triceps,
    ];

    public static bool IsValid(string? id) => id is not null && All.Contains(id, StringComparer.Ordinal);
}

/// <summary>Grupos que a tela usa nos filtros; cada músculo pertence a exatamente um.</summary>
public static class MuscleGroup
{
    public const string Chest = "chest";
    public const string Back = "back";
    public const string Legs = "legs";
    public const string Shoulders = "shoulders";
    public const string Arms = "arms";
    public const string Core = "core";

    public static IReadOnlyList<string> All { get; } = [Chest, Back, Legs, Shoulders, Arms, Core];

    // O pescoço não tem grupo próprio na tela: acompanha os ombros, que é onde o filtro o encontra.
    private static readonly Dictionary<string, string> ByMuscle = new(StringComparer.Ordinal)
    {
        [Muscle.Chest] = Chest,
        [Muscle.Lats] = Back,
        [Muscle.MiddleBack] = Back,
        [Muscle.LowerBack] = Back,
        [Muscle.Traps] = Back,
        [Muscle.Quadriceps] = Legs,
        [Muscle.Hamstrings] = Legs,
        [Muscle.Glutes] = Legs,
        [Muscle.Calves] = Legs,
        [Muscle.Adductors] = Legs,
        [Muscle.Abductors] = Legs,
        [Muscle.Shoulders] = Shoulders,
        [Muscle.Neck] = Shoulders,
        [Muscle.Biceps] = Arms,
        [Muscle.Triceps] = Arms,
        [Muscle.Forearms] = Arms,
        [Muscle.Abdominals] = Core,
    };

    /// <summary>Mapa músculo → grupo (cópia só de leitura, para os testes e para a conferência com o PWA).</summary>
    public static IReadOnlyDictionary<string, string> Map => ByMuscle;

    /// <summary>Grupo do músculo; músculo fora do conjunto é erro de programação, nunca um grupo "vazio".</summary>
    public static string Of(string muscle) =>
        ByMuscle.TryGetValue(muscle, out var group)
            ? group
            : throw new ArgumentOutOfRangeException(nameof(muscle), muscle, "Músculo sem grupo na taxonomia.");
}
