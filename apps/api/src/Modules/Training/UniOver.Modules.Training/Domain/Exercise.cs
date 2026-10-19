using UniOver.Modules.Training.Contracts;

namespace UniOver.Modules.Training.Domain;

/// <summary>
/// Um exercício do catálogo ou do próprio usuário. Linha de catálogo (<c>free_exercise_db</c>, <c>wger</c>) é só leitura
/// para o usuário; a única escolha dele sobre ela (o salto de carga) vive em <see cref="ExerciseOverride"/>, para a
/// semente poder corrigir o texto sem apagá-la.
/// </summary>
public sealed class Exercise
{
    public const int NameMax = 120;
    public const int InstructionsMax = 20;
    public const int InstructionMax = 500;
    public const int MusclesMax = 3;

    public Guid Id { get; set; }

    /// <summary>Único por <see cref="Source"/>.</summary>
    public string Slug { get; set; } = string.Empty;

    public string Source { get; set; } = ExerciseSources.Own;

    /// <summary>Id do registro na origem (único junto com <see cref="Source"/>); nulo no exercício próprio.</summary>
    public string? SourceRef { get; set; }

    public string Name { get; set; } = string.Empty;

    public List<string> Instructions { get; set; } = [];

    public List<string> PrimaryMuscles { get; set; } = [];

    public List<string> SecondaryMuscles { get; set; } = [];

    public string Equipment { get; set; } = Domain.Equipment.Other;

    public string RecordType { get; set; } = ExerciseRecordTypes.WeightReps;

    /// <summary>Salto de carga próprio; nulo vale o do equipamento.</summary>
    public decimal? StepKg { get; set; }

    // Textos de origem, só informativos (a tela não depende deles).
    public string? Level { get; set; }

    public string? Category { get; set; }

    public string? Mechanic { get; set; }

    public string? License { get; set; }

    public string? LicenseAuthor { get; set; }

    public string? LicenseUrl { get; set; }

    /// <summary>A tradução da semente foi conferida por uma pessoa.</summary>
    public bool Reviewed { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Relógio do servidor ao gravar: é o que ordena o cursor.</summary>
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Relógio do aparelho que escreveu: decide o conflito (último a escrever).</summary>
    public DateTimeOffset ClientUpdatedAt { get; set; }

    /// <summary>Lápide: apagar nunca remove a linha, para outro aparelho não ressuscitá-la.</summary>
    public DateTimeOffset? DeletedAt { get; set; }

    /// <summary>Dono do exercício próprio (outro módulo, só por id, sem chave estrangeira); nulo no catálogo.</summary>
    public Guid? OwnerUserId { get; set; }

    public bool IsDeleted => DeletedAt is not null;

    public bool IsCatalog => ExerciseSources.IsCatalog(Source);
}

/// <summary>Salto de carga que o dono escolheu para um exercício (de catálogo ou próprio), à parte da linha do exercício.</summary>
public sealed class ExerciseOverride
{
    public Guid UserId { get; set; }

    public Guid ExerciseId { get; set; }

    /// <summary>Nulo volta ao salto do equipamento.</summary>
    public decimal? StepKg { get; set; }

    public DateTimeOffset ClientUpdatedAt { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>Linha única que diz qual versão da semente já foi carregada (a carga é preguiçosa e versionada).</summary>
public sealed class CatalogMeta
{
    public const int SingleId = 1;

    public int Id { get; set; } = SingleId;

    public int SeedVersion { get; set; }

    public DateTimeOffset SeededAt { get; set; }
}
