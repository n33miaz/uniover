using UniOver.Modules.Training.Contracts;

namespace UniOver.Modules.Training.Domain.Sessions;

/// <summary>Regras puras da série: forma conforme o tipo de registro do exercício e passos do esforço.</summary>
public static class SetRules
{
    /// <summary>
    /// A forma da série depende de como o exercício é registrado: <c>weight_reps</c> exige repetições, e também a carga
    /// quando a série é de tipo <c>work</c> (o aquecimento e as demais podem ir sem carga); <c>reps_only</c> exige
    /// repetições; <c>time</c> exige a duração.
    /// </summary>
    public static bool HasValidShape(string recordType, string setType, decimal? weightKg, int? reps, int? durationS) =>
        recordType switch
        {
            ExerciseRecordTypes.WeightReps => reps is not null && (setType != SetTypes.Work || weightKg is not null),
            ExerciseRecordTypes.RepsOnly => reps is not null,
            ExerciseRecordTypes.Time => durationS is not null,
            _ => false,
        };

    /// <summary>O RPE só vale em passos de meio ponto (7, 7,5, 8...).</summary>
    public static bool IsHalfStep(decimal value) => value * 2 == decimal.Truncate(value * 2);
}
