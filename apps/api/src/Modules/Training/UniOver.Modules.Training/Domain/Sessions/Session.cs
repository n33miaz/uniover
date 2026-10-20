namespace UniOver.Modules.Training.Domain.Sessions;

/// <summary>Limites da sessão e da série: os mesmos valem na borda, no banco (check) e no aparelho.</summary>
public static class SessionLimits
{
    public const int NoteMax = 500;
    public const int SetNoteMax = 300;
    public const int DeviceIdMax = 64;
    public const int FeelingMin = 1;
    public const int FeelingMax = 5;
    public const int PositionMax = 100000;
    public const int RepsMax = 999;
    public const int RirMax = 10;
    public const decimal RpeMin = 1m;
    public const decimal RpeMax = 10m;
    public const int DurationMaxSeconds = 86400;
    public const decimal WeightMaxKg = 99999.99m;
}

/// <summary>Tipos de série. Os valores são estáveis: viajam no banco e na API.</summary>
public static class SetTypes
{
    public const string Warmup = "warmup";
    public const string Work = "work";
    public const string Failure = "failure";
    public const string Drop = "drop";

    public static IReadOnlyList<string> All { get; } = [Warmup, Work, Failure, Drop];

    public static bool IsValid(string? value) => value is Warmup or Work or Failure or Drop;
}

/// <summary>
/// Um treino ao vivo do usuário: começa quando ele inicia e termina quando ele encerra (<see cref="FinishedAt"/>).
/// O usuário é de outro módulo e entra só como id, sem chave estrangeira. Apagar não remove a linha: vira lápide
/// (<see cref="DeletedAt"/>), e as séries dela viram lápide junto. Só pode haver uma sessão aberta por usuário.
/// </summary>
public sealed class Session
{
    public Guid Id { get; set; }

    public Guid UserId { get; set; }

    /// <summary>Rotina que originou o treino (mesmo schema, com chave estrangeira); nulo no treino livre.</summary>
    public Guid? RoutineId { get; set; }

    public DateTimeOffset StartedAt { get; set; }

    /// <summary>Nulo enquanto o treino está em andamento.</summary>
    public DateTimeOffset? FinishedAt { get; set; }

    public string? Note { get; set; }

    /// <summary>Como o dono se sentiu, de 1 a 5.</summary>
    public int? Feeling { get; set; }

    /// <summary>Aparelho que abriu o treino (id gerado no próprio aparelho).</summary>
    public string DeviceId { get; set; } = string.Empty;

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Relógio do servidor ao gravar: é o que ordena o cursor.</summary>
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Relógio do aparelho que escreveu: decide o conflito (último a escrever).</summary>
    public DateTimeOffset ClientUpdatedAt { get; set; }

    public DateTimeOffset? DeletedAt { get; set; }

    public bool IsDeleted => DeletedAt is not null;

    /// <summary>Em andamento: não terminou e não foi apagada.</summary>
    public bool IsOpen => FinishedAt is null && DeletedAt is null;
}

/// <summary>Uma série registrada dentro de uma sessão.</summary>
public sealed class SessionSet
{
    public Guid Id { get; set; }

    public Guid UserId { get; set; }

    public Guid SessionId { get; set; }

    /// <summary>Exercício do catálogo ou do próprio usuário (mesmo schema, com chave estrangeira).</summary>
    public Guid ExerciseId { get; set; }

    /// <summary>Ordem da série dentro da sessão.</summary>
    public int Position { get; set; }

    public string SetType { get; set; } = SetTypes.Work;

    /// <summary>Carga em kg (nos halteres, a de um halter).</summary>
    public decimal? WeightKg { get; set; }

    public int? Reps { get; set; }

    /// <summary>Duração em segundos, para exercício de tipo tempo.</summary>
    public int? DurationS { get; set; }

    /// <summary>Repetições que ainda caberiam (0 a 10).</summary>
    public int? Rir { get; set; }

    /// <summary>Esforço percebido, de 1 a 10 em passos de 0,5.</summary>
    public decimal? Rpe { get; set; }

    public string? Note { get; set; }

    public DateTimeOffset CompletedAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }

    public DateTimeOffset ClientUpdatedAt { get; set; }

    public DateTimeOffset? DeletedAt { get; set; }

    public bool IsDeleted => DeletedAt is not null;
}
