using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Goals;

namespace UniOver.Modules.Training.Persistence.Configurations;

internal sealed class GoalConfiguration : IEntityTypeConfiguration<Goal>
{
    public void Configure(EntityTypeBuilder<Goal> e)
    {
        ArgumentNullException.ThrowIfNull(e);

        e.ToTable("goals", t =>
        {
            t.HasCheckConstraint("ck_goals_kind", "kind IN ('exercise_e1rm', 'weekly_sessions', 'daily_kcal')");

            // O exercício existe só na meta de 1RM; nos outros tipos ele seria ambíguo na chave natural.
            t.HasCheckConstraint("ck_goals_exercise", "(kind = 'exercise_e1rm') = (exercise_id IS NOT NULL)");

            // Sem valor só a lápide; com valor, dentro da faixa do tipo. O "IS NOT NULL" explícito importa: um check que
            // dá NULL (valor nulo comparado com a faixa) é aceito pelo Postgres, e a meta sem valor passaria viva.
            t.HasCheckConstraint(
                "ck_goals_value",
                "(value IS NOT NULL AND (" +
                $"(kind = 'exercise_e1rm' AND value BETWEEN {GoalLimits.ExerciseE1rmMin} AND {GoalLimits.ExerciseE1rmMax}) OR " +
                $"(kind = 'weekly_sessions' AND value BETWEEN {GoalLimits.WeeklySessionsMin} AND {GoalLimits.WeeklySessionsMax}) OR " +
                $"(kind = 'daily_kcal' AND value BETWEEN {GoalLimits.DailyKcalMin} AND {GoalLimits.DailyKcalMax}))) OR " +
                "(value IS NULL AND deleted_at IS NOT NULL)");
        });
        e.HasKey(x => x.Id);
        e.Property(x => x.Id).ValueGeneratedNever();

        // O usuário é de outro módulo: só o id, sem chave estrangeira.
        e.Property(x => x.UserId).IsRequired();
        e.Property(x => x.Kind).HasMaxLength(20).IsRequired();
        e.Property(x => x.Value).HasPrecision(9, 2);

        // Chave natural. O exercício é nulo nos tipos sem exercício, e no Postgres NULL é diferente de NULL num índice
        // único comum: sem "nulos iguais" 50 pedidos simultâneos criariam 50 linhas da mesma meta.
        e.HasIndex(x => new { x.UserId, x.Kind, x.ExerciseId })
            .IsUnique()
            .AreNullsDistinct(false);

        // A ordem do cursor da leitura incremental, sempre dentro de um usuário.
        e.HasIndex(x => new { x.UserId, x.UpdatedAt, x.Id });

        // Mesmo schema: a chave estrangeira para o exercício é permitida. Restrict porque o exercício nunca é apagado de
        // verdade (a linha vira lápide).
        e.HasOne<Exercise>().WithMany().HasForeignKey(x => x.ExerciseId).OnDelete(DeleteBehavior.Restrict);
        e.HasIndex(x => x.ExerciseId);

        // Duas escritas ao mesmo tempo na mesma meta: a que chega com o valor antigo é recusada e relê (último a escrever).
        e.Property(x => x.ClientUpdatedAt).IsConcurrencyToken();

        e.Ignore(x => x.IsDeleted);
    }
}
