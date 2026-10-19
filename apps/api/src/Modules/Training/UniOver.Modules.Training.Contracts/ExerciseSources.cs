namespace UniOver.Modules.Training.Contracts;

/// <summary>De onde veio um exercício do catálogo. Os valores são estáveis: viajam no banco e na API.</summary>
public static class ExerciseSources
{
    /// <summary>Semente embutida, reescrita em português a partir do texto da free-exercise-db.</summary>
    public const string FreeExerciseDb = "free_exercise_db";

    /// <summary>Importado do wger, com autor e licença guardados em cada registro.</summary>
    public const string Wger = "wger";

    /// <summary>Criado pelo próprio usuário; só ele o vê e o edita.</summary>
    public const string Own = "own";

    public static IReadOnlyList<string> All { get; } = [FreeExerciseDb, Wger, Own];

    public static bool IsCatalog(string source) => source is FreeExerciseDb or Wger;
}

/// <summary>Como as séries de um exercício são registradas.</summary>
public static class ExerciseRecordTypes
{
    public const string WeightReps = "weight_reps";
    public const string RepsOnly = "reps_only";
    public const string Time = "time";

    public static IReadOnlyList<string> All { get; } = [WeightReps, RepsOnly, Time];

    public static bool IsValid(string? value) => value is WeightReps or RepsOnly or Time;
}
