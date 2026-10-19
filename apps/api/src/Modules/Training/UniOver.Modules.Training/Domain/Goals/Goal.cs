namespace UniOver.Modules.Training.Domain.Goals;

/// <summary>Os tipos de meta do dono. Os valores são estáveis: viajam no banco, na rota e na API.</summary>
public static class GoalKinds
{
    /// <summary>1RM estimado que o dono quer alcançar num exercício (kg).</summary>
    public const string ExerciseE1rm = "exercise_e1rm";

    /// <summary>Quantos treinos por semana.</summary>
    public const string WeeklySessions = "weekly_sessions";

    /// <summary>Calorias por dia (a tela da meta calórica usa este tipo).</summary>
    public const string DailyKcal = "daily_kcal";

    public static IReadOnlyList<string> All { get; } = [ExerciseE1rm, WeeklySessions, DailyKcal];

    public static bool IsValid(string? value) => value is ExerciseE1rm or WeeklySessions or DailyKcal;

    /// <summary>Só a meta de 1RM é por exercício; as demais valem para a pessoa toda.</summary>
    public static bool RequiresExercise(string kind) => kind == ExerciseE1rm;
}

/// <summary>Faixa de valores aceita por tipo de meta: a mesma vale na borda, no banco (check) e no aparelho.</summary>
public static class GoalLimits
{
    public const decimal ExerciseE1rmMin = 1m;
    public const decimal ExerciseE1rmMax = 1000m;
    public const decimal WeeklySessionsMin = 1m;
    public const decimal WeeklySessionsMax = 14m;
    public const decimal DailyKcalMin = 500m;
    public const decimal DailyKcalMax = 10000m;

    /// <summary>Casas decimais guardadas (<c>numeric(9,2)</c>).</summary>
    public const int ValueScale = 2;

    /// <summary>Faixa do tipo, ou <c>null</c> para um tipo desconhecido.</summary>
    public static (decimal Min, decimal Max)? RangeOf(string kind) => kind switch
    {
        GoalKinds.ExerciseE1rm => (ExerciseE1rmMin, ExerciseE1rmMax),
        GoalKinds.WeeklySessions => (WeeklySessionsMin, WeeklySessionsMax),
        GoalKinds.DailyKcal => (DailyKcalMin, DailyKcalMax),
        _ => null,
    };

    /// <summary>O valor está dentro da faixa do tipo e não tem mais casas decimais do que o banco guarda.</summary>
    public static bool IsValid(string kind, decimal value) =>
        RangeOf(kind) is { } range
        && value >= range.Min
        && value <= range.Max
        && decimal.Round(value, ValueScale) == value;
}

/// <summary>
/// Uma meta do dono. A chave natural é (<see cref="UserId"/>, <see cref="Kind"/>, <see cref="ExerciseId"/>): o mesmo
/// pedido repetido nunca cria uma segunda linha. Apagar não remove a linha: vira lápide (<see cref="DeletedAt"/>) e o
/// valor fica vazio. O usuário é de outro módulo e entra só como id, sem chave estrangeira.
/// </summary>
public sealed class Goal
{
    public Guid Id { get; set; }

    public Guid UserId { get; set; }

    public string Kind { get; set; } = GoalKinds.WeeklySessions;

    /// <summary>Exercício da meta de 1RM (mesmo schema, com chave estrangeira); nulo nos outros tipos.</summary>
    public Guid? ExerciseId { get; set; }

    /// <summary>Valor da meta; vazio só na lápide.</summary>
    public decimal? Value { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Relógio do servidor ao gravar: é o que ordena o cursor.</summary>
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Relógio do aparelho que escreveu: decide o conflito (último a escrever).</summary>
    public DateTimeOffset ClientUpdatedAt { get; set; }

    public DateTimeOffset? DeletedAt { get; set; }

    public bool IsDeleted => DeletedAt is not null;
}
