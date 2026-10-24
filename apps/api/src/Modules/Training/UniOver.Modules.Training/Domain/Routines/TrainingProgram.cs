namespace UniOver.Modules.Training.Domain.Routines;

/// <summary>Escolha sincronizada do programa semanal de uma conta.</summary>
public sealed class TrainingProgram
{
    public Guid UserId { get; set; }
    public string ProgramId { get; set; } = string.Empty;
    /// <summary>Relógio do servidor ao gravar: é o que ordena o cursor.</summary>
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Relógio do aparelho que escolheu: decide o conflito (último a escrever).</summary>
    public DateTimeOffset ClientUpdatedAt { get; set; }
}
