using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Routines;

namespace UniOver.Modules.Training.Persistence.Configurations;

internal sealed class RoutineConfiguration : IEntityTypeConfiguration<Routine>
{
    public void Configure(EntityTypeBuilder<Routine> e)
    {
        ArgumentNullException.ThrowIfNull(e);

        e.ToTable("routines", t =>
        {
            t.HasCheckConstraint("ck_routines_name", $"char_length(name) BETWEEN 1 AND {RoutineLimits.NameMax}");
            t.HasCheckConstraint("ck_routines_position", $"position BETWEEN 0 AND {RoutineLimits.PositionMax}");
        });
        e.HasKey(x => x.Id);
        e.Property(x => x.Id).ValueGeneratedNever();

        // O usuário é de outro módulo: só o id, sem chave estrangeira.
        e.Property(x => x.UserId).IsRequired();
        e.Property(x => x.Name).HasMaxLength(RoutineLimits.NameMax).IsRequired();
        e.Property(x => x.Note).HasMaxLength(RoutineLimits.NoteMax);
        e.Property(x => x.ProgramId).HasMaxLength(RoutineLimits.ProgramIdMax);
        e.Property(x => x.Weekdays).HasColumnType("integer[]");

        // A ordem do cursor da leitura incremental, sempre dentro de um usuário.
        e.HasIndex(x => new { x.UserId, x.UpdatedAt, x.Id });

        // Duas escritas ao mesmo tempo na mesma rotina: a que chega com o valor antigo é recusada e relê (último a escrever).
        e.Property(x => x.ClientUpdatedAt).IsConcurrencyToken();

        // Os itens moram e morrem com a rotina (mesmo schema, então a chave estrangeira é permitida).
        e.HasMany(x => x.Items).WithOne().HasForeignKey(i => i.RoutineId).OnDelete(DeleteBehavior.Cascade);
        e.Ignore(x => x.IsDeleted);
    }
}

internal sealed class TrainingProgramConfiguration : IEntityTypeConfiguration<TrainingProgram>
{
    public void Configure(EntityTypeBuilder<TrainingProgram> e)
    {
        e.ToTable("programs");
        // Um programa por pessoa: a chave primária recusa a segunda inserção simultânea, quem perde relê e decide de novo.
        e.HasKey(x => x.UserId);
        e.Property(x => x.UserId).ValueGeneratedNever();
        e.Property(x => x.ProgramId).HasMaxLength(RoutineLimits.ProgramIdMax).IsRequired();
        e.Property(x => x.ClientUpdatedAt).IsConcurrencyToken();
    }
}

internal sealed class RoutineItemConfiguration : IEntityTypeConfiguration<RoutineItem>
{
    public void Configure(EntityTypeBuilder<RoutineItem> e)
    {
        ArgumentNullException.ThrowIfNull(e);

        e.ToTable("routine_items", t =>
        {
            t.HasCheckConstraint("ck_routine_items_sets", $"target_sets BETWEEN {RoutineLimits.SetsMin} AND {RoutineLimits.SetsMax}");
            t.HasCheckConstraint("ck_routine_items_reps", $"rep_min BETWEEN {RoutineLimits.RepsMin} AND {RoutineLimits.RepsMax} AND rep_max BETWEEN {RoutineLimits.RepsMin} AND {RoutineLimits.RepsMax} AND rep_min <= rep_max");
            t.HasCheckConstraint("ck_routine_items_rest", $"rest_seconds BETWEEN 0 AND {RoutineLimits.RestMax}");
            t.HasCheckConstraint("ck_routine_items_position", "position >= 0");
            t.HasCheckConstraint("ck_routine_items_superset", $"superset_group IS NULL OR superset_group BETWEEN {RoutineLimits.SupersetGroupMin} AND {RoutineLimits.SupersetGroupMax}");
        });

        // O id do item nasce no aparelho e só é único dentro da rotina: assim o id de um item de outra rotina (ou de outro
        // usuário) nunca colide nem revela que existe.
        e.HasKey(x => new { x.RoutineId, x.Id });
        e.Property(x => x.Id).ValueGeneratedNever();
        e.Property(x => x.Note).HasMaxLength(RoutineLimits.ItemNoteMax);

        // Mesmo schema: a chave estrangeira para o exercício é permitida. Restrict porque o exercício nunca é apagado de
        // verdade (a linha vira lápide) e uma rotina não pode perder o exercício sem aviso.
        e.HasOne<Exercise>().WithMany().HasForeignKey(x => x.ExerciseId).OnDelete(DeleteBehavior.Restrict);
        e.HasIndex(x => x.ExerciseId);
    }
}
