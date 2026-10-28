namespace UniOver.Modules.Training.Domain.Body;

/// <summary>
/// Limites do corpo: os mesmos valem na borda, no banco (check) e no aparelho. Os números são faixas de bom senso para
/// recusar digitação errada, não uma opinião sobre saúde.
/// </summary>
public static class BodyLimits
{
    public const decimal HeightMinCm = 100m;
    public const decimal HeightMaxCm = 250m;

    /// <summary>Casas decimais da altura e das medidas (<c>numeric(4,1)</c>).</summary>
    public const int OneDecimalScale = 1;

    public const decimal ActivityFactorMin = 1.0m;
    public const decimal ActivityFactorMax = 2.5m;

    /// <summary>Valor assumido quando o aparelho não manda o fator: o do protótipo aprovado (editável pelo dono).</summary>
    public const decimal ActivityFactorDefault = 1.55m;

    /// <summary>Casas decimais do fator de atividade (<c>numeric(3,2)</c>).</summary>
    public const int ActivityFactorScale = 2;

    public const decimal WeightMinKg = 20m;
    public const decimal WeightMaxKg = 400m;

    /// <summary>Casas decimais do peso (<c>numeric(5,2)</c>).</summary>
    public const int WeightScale = 2;

    public const decimal BodyFatMinPct = 2m;
    public const decimal BodyFatMaxPct = 70m;

    public const decimal CircumferenceMinCm = 10m;
    public const decimal CircumferenceMaxCm = 250m;
    public const decimal SkinfoldMinMm = 1m;
    public const decimal SkinfoldMaxMm = 100m;

    public const int NoteMax = 300;

    /// <summary>Data mais antiga aceita (nascimento e medição). Acima disso é erro de digitação.</summary>
    public static readonly DateOnly EarliestDate = new(1900, 1, 1);

    /// <summary>
    /// A medição é na data local do aparelho, que pode estar um dia à frente da data UTC do servidor (fuso de +14 h): um
    /// dia de folga evita recusar quem mediu "hoje" do outro lado do mundo.
    /// </summary>
    public static readonly TimeSpan MeasuredOnLeeway = TimeSpan.FromDays(1);

    /// <summary>O valor está dentro da faixa e não tem mais casas decimais do que o banco guarda.</summary>
    public static bool IsValid(decimal value, decimal min, decimal max, int scale) =>
        value >= min && value <= max && decimal.Round(value, scale) == value;

    public static bool IsValidWeight(decimal value) => IsValid(value, WeightMinKg, WeightMaxKg, WeightScale);

    public static bool IsValidBodyFat(decimal value) => IsValid(value, BodyFatMinPct, BodyFatMaxPct, OneDecimalScale);

    public static bool IsValidCircumference(decimal value) =>
        IsValid(value, CircumferenceMinCm, CircumferenceMaxCm, OneDecimalScale);

    public static bool IsValidSkinfold(decimal value) =>
        IsValid(value, SkinfoldMinMm, SkinfoldMaxMm, OneDecimalScale);

    public static bool IsValidHeight(decimal value) => IsValid(value, HeightMinCm, HeightMaxCm, OneDecimalScale);

    public static bool IsValidActivityFactor(decimal value) =>
        IsValid(value, ActivityFactorMin, ActivityFactorMax, ActivityFactorScale);
}

/// <summary>Como o percentual de gordura foi obtido. Os valores são estáveis: viajam no banco e na API.</summary>
public static class FatMethods
{
    /// <summary>Calculado no aparelho pela fórmula da Marinha dos EUA (o servidor só guarda o resultado).</summary>
    public const string Navy = "navy";

    /// <summary>Digitado pelo dono (adipômetro, exame, o que ele quiser).</summary>
    public const string Manual = "manual";

    /// <summary>Lido de uma balança de bioimpedância.</summary>
    public const string Bioimpedance = "bioimpedance";

    public static IReadOnlyList<string> All { get; } = [Navy, Manual, Bioimpedance];

    public static bool IsValid(string? value) => value is Navy or Manual or Bioimpedance;
}

/// <summary>Sexo para as fórmulas de gasto e de gordura (que são por sexo). Os valores são estáveis.</summary>
public static class BodySexes
{
    public const string Male = "male";
    public const string Female = "female";

    public static IReadOnlyList<string> All { get; } = [Male, Female];

    public static bool IsValid(string? value) => value is Male or Female;
}

/// <summary>
/// Uma medição do corpo do dono (peso, gordura, circunferências) numa data. Todos os valores são opcionais, mas a medição
/// viva precisa de pelo menos um. O servidor não calcula nada de saúde: guarda o que o aparelho calculou, com o método.
/// Apagar não remove a linha: vira lápide (<see cref="DeletedAt"/>) e os valores são esvaziados (não há motivo para
/// guardar dado de saúde de algo que o dono apagou). O usuário é de outro módulo e entra só como id, sem chave estrangeira.
/// </summary>
public sealed class BodyEntry
{
    public Guid Id { get; set; }

    public Guid UserId { get; set; }

    /// <summary>Data local do aparelho em que a medição foi feita.</summary>
    public DateOnly MeasuredOn { get; set; }

    public decimal? WeightKg { get; set; }

    public decimal? BodyFatPct { get; set; }

    /// <summary>Presente se, e só se, <see cref="BodyFatPct"/> está presente.</summary>
    public string? FatMethod { get; set; }

    public decimal? WaistCm { get; set; }

    public decimal? NeckCm { get; set; }

    public decimal? HipCm { get; set; }

    public decimal? ArmCm { get; set; }

    public decimal? ThighCm { get; set; }

    public decimal? ChestCm { get; set; }

    public decimal? AbdomenCm { get; set; }

    public decimal? ForearmCm { get; set; }

    public decimal? CalfCm { get; set; }

    public decimal? ArmRightCm { get; set; }

    public decimal? ArmLeftCm { get; set; }

    public decimal? ForearmRightCm { get; set; }

    public decimal? ForearmLeftCm { get; set; }

    public decimal? ThighRightCm { get; set; }

    public decimal? ThighLeftCm { get; set; }

    public decimal? CalfRightCm { get; set; }

    public decimal? CalfLeftCm { get; set; }

    public decimal? ChestSkinfoldMm { get; set; }

    public decimal? AbdomenSkinfoldMm { get; set; }

    public decimal? ThighSkinfoldMm { get; set; }

    public string? Note { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Relógio do servidor ao gravar: é o que ordena o cursor.</summary>
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Relógio do aparelho que escreveu: decide o conflito (último a escrever).</summary>
    public DateTimeOffset ClientUpdatedAt { get; set; }

    public DateTimeOffset? DeletedAt { get; set; }

    public bool IsDeleted => DeletedAt is not null;

    /// <summary>Tem ao menos um valor medido (a anotação sozinha não conta).</summary>
    public bool HasAnyValue =>
        WeightKg is not null || BodyFatPct is not null || WaistCm is not null || NeckCm is not null
        || HipCm is not null || ArmCm is not null || ThighCm is not null || ChestCm is not null || AbdomenCm is not null
        || ForearmCm is not null || CalfCm is not null || ArmRightCm is not null || ArmLeftCm is not null
        || ForearmRightCm is not null || ForearmLeftCm is not null || ThighRightCm is not null || ThighLeftCm is not null
        || CalfRightCm is not null || CalfLeftCm is not null || ChestSkinfoldMm is not null || AbdomenSkinfoldMm is not null
        || ThighSkinfoldMm is not null;
}

/// <summary>
/// O perfil do dono que as fórmulas pedem (altura, nascimento, sexo e o fator de atividade). A chave natural é o usuário:
/// há no máximo um perfil por pessoa e ele não tem lápide (não existe "apagar perfil"; troca-se o valor). O usuário é de
/// outro módulo e entra só como id, sem chave estrangeira.
/// </summary>
public sealed class BodyProfile
{
    public Guid UserId { get; set; }

    public decimal HeightCm { get; set; }

    public DateOnly BirthDate { get; set; }

    public string Sex { get; set; } = BodySexes.Male;

    public decimal ActivityFactor { get; set; } = BodyLimits.ActivityFactorDefault;

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Relógio do servidor ao gravar: é o que ordena o cursor.</summary>
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Relógio do aparelho que escreveu: decide o conflito (último a escrever).</summary>
    public DateTimeOffset ClientUpdatedAt { get; set; }
}
