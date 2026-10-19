using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Goals;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Goals.UpsertGoal;

/// <summary>
/// Grava, troca ou remove (por lápide) a meta do usuário, achando-a pela chave natural (tipo + exercício). É idempotente
/// com ou sem o filtro de <c>Idempotency-Key</c>: o reenvio não muda nada, e pedidos simultâneos da mesma meta terminam
/// numa linha só (o índice único decide; quem perde relê pela chave natural e aplica o último a escrever).
/// </summary>
internal sealed class UpsertGoalHandler(TrainingDbContext db, CatalogSeeder seeder, TimeProvider time)
{
    // Cada rodada perdida significa que outra escrita ganhou; com conteúdo igual a segunda rodada já encerra sem gravar.
    private const int MaxAttempts = 8;

    public async Task<UpsertGoalResult> HandleAsync(UpsertGoalCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var now = TimeStamps.ToStorage(time.GetUtcNow());
        if (LastWriterWins.IsClockAhead(command.ClientUpdatedAt, now))
        {
            return new UpsertGoalResult(UpsertGoalOutcome.ClockAhead);
        }

        if (command.ExerciseId is { } exerciseId && !await ExerciseExistsAsync(exerciseId, command.UserId, cancellationToken))
        {
            return new UpsertGoalResult(UpsertGoalOutcome.ExerciseNotFound);
        }

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var row = await FindAsync(command, cancellationToken);
            if (row is null)
            {
                row = new Goal
                {
                    Id = Guid.CreateVersion7(),
                    UserId = command.UserId,
                    Kind = command.Kind,
                    ExerciseId = command.ExerciseId,
                    CreatedAt = now,
                };
                Apply(row, command, now);
                db.Set<Goal>().Add(row);
            }
            else if (!LastWriterWins.ShouldApply(command.ClientUpdatedAt, row.ClientUpdatedAt) || IsSame(row, command))
            {
                // Escrita mais velha (ou reenvio idêntico): vale o que já está guardado.
                return new UpsertGoalResult(UpsertGoalOutcome.Ok, GoalResponse.From(row));
            }
            else
            {
                Apply(row, command, now);
            }

            try
            {
                await db.SaveChangesAsync(cancellationToken);
                return new UpsertGoalResult(UpsertGoalOutcome.Ok, GoalResponse.From(row));
            }
            catch (DbUpdateConcurrencyException)
            {
                db.ChangeTracker.Clear();
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                // Outra escrita criou a mesma meta no mesmo instante: relê pela chave natural e decide de novo.
                db.ChangeTracker.Clear();
            }
        }

        throw new InvalidOperationException("Não foi possível gravar a meta: muitas escritas concorrentes na mesma meta.");
    }

    /// <summary>
    /// O exercício precisa existir e ser do catálogo ou do usuário (o de outra pessoa conta como inexistente). O próprio já
    /// apagado ainda vale: apagá-lo num aparelho não pode fazer a meta de outro aparelho falhar para sempre na fila. O
    /// catálogo é carregado de forma preguiçosa: só quando o exercício não aparece a semente é garantida e a busca refeita.
    /// </summary>
    private async Task<bool> ExerciseExistsAsync(Guid exerciseId, Guid userId, CancellationToken cancellationToken)
    {
        if (await QueryExerciseAsync(exerciseId, userId, cancellationToken))
        {
            return true;
        }

        await seeder.EnsureSeededAsync(cancellationToken);
        return await QueryExerciseAsync(exerciseId, userId, cancellationToken);
    }

    private Task<bool> QueryExerciseAsync(Guid exerciseId, Guid userId, CancellationToken cancellationToken) =>
        db.Exercises.AsNoTracking().AnyAsync(
            e => e.Id == exerciseId && (e.OwnerUserId == null || e.OwnerUserId == userId), cancellationToken);

    private Task<Goal?> FindAsync(UpsertGoalCommand command, CancellationToken cancellationToken)
    {
        var userId = command.UserId;
        var kind = command.Kind;
        var exerciseId = command.ExerciseId;

        // A comparação com o exercício nulo é traduzida pelo EF como IS NULL: a chave natural também vale sem exercício.
        return db.Set<Goal>().SingleOrDefaultAsync(
            g => g.UserId == userId && g.Kind == kind && g.ExerciseId == exerciseId, cancellationToken);
    }

    private static void Apply(Goal row, UpsertGoalCommand command, DateTimeOffset now)
    {
        // Lápide: a linha fica (outro aparelho precisa saber que a meta foi removida); reversível por um PUT mais novo.
        row.Value = command.Value;
        row.DeletedAt = command.Value is null ? now : null;
        row.ClientUpdatedAt = command.ClientUpdatedAt;
        row.UpdatedAt = now;
    }

    private static bool IsSame(Goal row, UpsertGoalCommand command) =>
        row.ClientUpdatedAt == command.ClientUpdatedAt
        && row.IsDeleted == (command.Value is null)
        && (command.Value is null || row.Value == command.Value);
}
