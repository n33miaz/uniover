using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Routines;
using UniOver.Modules.Training.Domain.Sessions;

namespace UniOver.Modules.Training.Persistence.Configurations;

internal sealed class SessionConfiguration : IEntityTypeConfiguration<Session>
{
    public void Configure(EntityTypeBuilder<Session> e)
    {
        ArgumentNullException.ThrowIfNull(e);

        e.ToTable("sessions", t =>
        {
            t.HasCheckConstraint("ck_sessions_note", $"note IS NULL OR char_length(note) <= {SessionLimits.NoteMax}");
            t.HasCheckConstraint("ck_sessions_feeling", $"feeling IS NULL OR feeling BETWEEN {SessionLimits.FeelingMin} AND {SessionLimits.FeelingMax}");
            t.HasCheckConstraint("ck_sessions_device", $"char_length(device_id) BETWEEN 1 AND {SessionLimits.DeviceIdMax}");
            t.HasCheckConstraint("ck_sessions_finish", "finished_at IS NULL OR finished_at >= started_at");
        });
        e.HasKey(x => x.Id);
        e.Property(x => x.Id).ValueGeneratedNever();

        // O usuário é de outro módulo: só o id, sem chave estrangeira.
        e.Property(x => x.UserId).IsRequired();
        e.Property(x => x.Note).HasMaxLength(SessionLimits.NoteMax);
        e.Property(x => x.DeviceId).HasMaxLength(SessionLimits.DeviceIdMax).IsRequired();

        // A ordem do cursor da leitura incremental, sempre dentro de um usuário.
        e.HasIndex(x => new { x.UserId, x.UpdatedAt, x.Id });

        // Um aparelho por vez: o banco recusa a segunda sessão aberta do mesmo usuário (sem apagada e sem terminada).
        // É a trava que vale mesmo quando dois aparelhos abrem ao mesmo tempo.
        e.HasIndex(x => x.UserId)
            .IsUnique()
            .HasFilter("finished_at IS NULL AND deleted_at IS NULL");

        // Mesmo schema: a chave estrangeira para a rotina é permitida. Restrict porque a rotina nunca é apagada de verdade
        // (a linha vira lápide).
        e.HasOne<Routine>().WithMany().HasForeignKey(x => x.RoutineId).OnDelete(DeleteBehavior.Restrict);
        e.HasIndex(x => x.RoutineId);

        // Duas escritas ao mesmo tempo na mesma sessão: a que chega com o valor antigo é recusada e relê (último a escrever).
        e.Property(x => x.ClientUpdatedAt).IsConcurrencyToken();

        e.Ignore(x => x.IsDeleted);
        e.Ignore(x => x.IsOpen);
    }
}

internal sealed class SessionSetConfiguration : IEntityTypeConfiguration<SessionSet>
{
    public void Configure(EntityTypeBuilder<SessionSet> e)
    {
        ArgumentNullException.ThrowIfNull(e);

        e.ToTable("session_sets", t =>
        {
            t.HasCheckConstraint("ck_session_sets_type", "set_type IN ('warmup', 'work', 'failure', 'drop')");
            t.HasCheckConstraint("ck_session_sets_position", $"position BETWEEN 0 AND {SessionLimits.PositionMax}");
            t.HasCheckConstraint("ck_session_sets_weight", "weight_kg IS NULL OR weight_kg >= 0");
            t.HasCheckConstraint("ck_session_sets_reps", $"reps IS NULL OR reps BETWEEN 0 AND {SessionLimits.RepsMax}");
            t.HasCheckConstraint("ck_session_sets_duration", $"duration_s IS NULL OR duration_s BETWEEN 0 AND {SessionLimits.DurationMaxSeconds}");
            t.HasCheckConstraint("ck_session_sets_rir", $"rir IS NULL OR rir BETWEEN 0 AND {SessionLimits.RirMax}");
            t.HasCheckConstraint("ck_session_sets_rpe", "rpe IS NULL OR (rpe BETWEEN 1 AND 10 AND rpe * 2 = trunc(rpe * 2))");
            t.HasCheckConstraint("ck_session_sets_note", $"note IS NULL OR char_length(note) <= {SessionLimits.SetNoteMax}");
        });
        e.HasKey(x => x.Id);
        e.Property(x => x.Id).ValueGeneratedNever();

        // O usuário é de outro módulo: só o id, sem chave estrangeira.
        e.Property(x => x.UserId).IsRequired();
        e.Property(x => x.SetType).HasMaxLength(10).IsRequired();
        e.Property(x => x.WeightKg).HasPrecision(7, 2);
        e.Property(x => x.Rpe).HasPrecision(3, 1);
        e.Property(x => x.Note).HasMaxLength(SessionLimits.SetNoteMax);

        // Cursor da leitura incremental e histórico por exercício (a progressão olha o exercício ao longo do tempo).
        e.HasIndex(x => new { x.UserId, x.UpdatedAt, x.Id });
        e.HasIndex(x => new { x.UserId, x.ExerciseId, x.CompletedAt });

        // As séries moram e morrem com a sessão; o exercício nunca é apagado de verdade (a linha vira lápide).
        e.HasOne<Session>().WithMany().HasForeignKey(x => x.SessionId).OnDelete(DeleteBehavior.Cascade);
        e.HasOne<Exercise>().WithMany().HasForeignKey(x => x.ExerciseId).OnDelete(DeleteBehavior.Restrict);
        e.HasIndex(x => x.SessionId);
        e.HasIndex(x => x.ExerciseId);

        e.Property(x => x.ClientUpdatedAt).IsConcurrencyToken();
        e.Ignore(x => x.IsDeleted);
    }
}
