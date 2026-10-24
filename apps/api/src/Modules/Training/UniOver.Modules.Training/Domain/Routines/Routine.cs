namespace UniOver.Modules.Training.Domain.Routines;

/// <summary>Limites da rotina: os mesmos valem na borda, no banco (check) e no aparelho.</summary>
public static class RoutineLimits
{
    public const int NameMax = 80;
    public const int NoteMax = 500;
    public const int ItemNoteMax = 300;
    public const int ProgramIdMax = 80;
    public const int MaxItems = 40;
    public const int PositionMax = 1000;
    public const int SetsMin = 1;
    public const int SetsMax = 20;
    public const int RepsMin = 1;
    public const int RepsMax = 100;
    public const int RestMax = 1800;
    public const int SupersetGroupMin = 1;
    public const int SupersetGroupMax = 100;
}

/// <summary>
/// Uma rotina (ficha) do usuário, por exemplo "A", "B" ou "C": um agregado pequeno, sempre escrito e lido inteiro,
/// cabeçalho e itens juntos. O usuário é de outro módulo e entra só como id, sem chave estrangeira. Apagar não remove a
/// linha: vira lápide (<see cref="DeletedAt"/>), para outro aparelho não ressuscitar a rotina.
/// </summary>
public sealed class Routine
{
    public Guid Id { get; set; }

    public Guid UserId { get; set; }

    public string Name { get; set; } = string.Empty;

    /// <summary>Ordem da rotina na sequência (A, B, C...); é o que define a "próxima".</summary>
    public int Position { get; set; }

    /// <summary>Rotina inativa continua guardada, mas fica fora da sequência.</summary>
    public bool Active { get; set; } = true;

    /// <summary>Programa semanal que criou esta ficha; nulo para fichas livres já existentes.</summary>
    public string? ProgramId { get; set; }

    /// <summary>Dias ISO (1=segunda ... 7=domingo) em que a ficha é sugerida. Vazio significa alternância.</summary>
    public int[] Weekdays { get; set; } = [];

    public string? Note { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Relógio do servidor ao gravar: é o que ordena o cursor.</summary>
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Relógio do aparelho que escreveu: decide o conflito (último a escrever).</summary>
    public DateTimeOffset ClientUpdatedAt { get; set; }

    public DateTimeOffset? DeletedAt { get; set; }

    public List<RoutineItem> Items { get; set; } = [];

    public bool IsDeleted => DeletedAt is not null;
}

/// <summary>
/// Um exercício dentro da rotina, com a meta dele. Itens vizinhos com o mesmo <see cref="SupersetGroup"/> formam uma
/// supersérie. O item não tem lápide própria: quem some do corpo da escrita some do banco.
/// </summary>
public sealed class RoutineItem
{
    public Guid RoutineId { get; set; }

    /// <summary>Id do item, gerado no aparelho; único dentro da rotina.</summary>
    public Guid Id { get; set; }

    /// <summary>Exercício do catálogo ou do próprio usuário (mesmo schema, com chave estrangeira).</summary>
    public Guid ExerciseId { get; set; }

    public int Position { get; set; }

    public int TargetSets { get; set; }

    public int RepMin { get; set; }

    public int RepMax { get; set; }

    public int RestSeconds { get; set; }

    public int? SupersetGroup { get; set; }

    public string? Note { get; set; }
}
