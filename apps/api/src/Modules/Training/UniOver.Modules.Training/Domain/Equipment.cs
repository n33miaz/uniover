namespace UniOver.Modules.Training.Domain;

/// <summary>
/// Equipamentos do catálogo (conjunto fechado) e o salto mínimo de carga de cada um. Os saltos são o palpite inicial do
/// projeto, não vêm de fonte: variam por academia, e cada exercício pode sobrescrever o seu.
/// </summary>
public static class Equipment
{
    public const string Barbell = "barbell";
    public const string Dumbbell = "dumbbell";
    public const string Machine = "machine";
    public const string Cable = "cable";
    public const string Bodyweight = "bodyweight";
    public const string Kettlebell = "kettlebell";
    public const string Band = "band";
    public const string Cardio = "cardio";
    public const string Other = "other";

    public static IReadOnlyList<string> All { get; } = [Barbell, Dumbbell, Machine, Cable, Bodyweight, Kettlebell, Band, Cardio, Other];

    public static bool IsValid(string? id) => id is not null && All.Contains(id, StringComparer.Ordinal);

    /// <summary>Salto mínimo de carga (kg) quando o exercício não define o seu.</summary>
    public static decimal DefaultStepKg(string equipment) => equipment switch
    {
        Barbell => 2.5m,
        Dumbbell => 2m,
        Machine => 5m,
        Cable => 5m,
        Bodyweight => 0m,
        Kettlebell => 4m,
        Band => 0m,
        Cardio => 0m,
        Other => 0m,
        _ => throw new ArgumentOutOfRangeException(nameof(equipment), equipment, "Equipamento fora da taxonomia."),
    };
}
