using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Catalog.SetExerciseStep;

/// <summary>Corpo do <c>PUT /exercises/{id}/step</c>: <c>stepKg</c> nulo devolve o salto ao do equipamento.</summary>
internal sealed record SetExerciseStepRequest(decimal? StepKg, DateTimeOffset? ClientUpdatedAt);

internal sealed record SetExerciseStepCommand(Guid UserId, Guid ExerciseId, decimal? StepKg, DateTimeOffset ClientUpdatedAt);

internal enum SetStepOutcome
{
    Ok,
    NotFound,
    ClockAhead,
}

internal sealed record SetExerciseStepResult(SetStepOutcome Outcome, ExerciseResponse? Exercise = null);

/// <summary>
/// Grava a escolha de salto de carga do dono para qualquer exercício visível a ele, <b>fora</b> da linha do exercício
/// (<c>exercise_overrides</c>), para a semente poder corrigir o texto do catálogo sem apagar a escolha. Idempotente por
/// (usuário, exercício) e com a regra do último a escrever.
/// </summary>
internal sealed class SetExerciseStepHandler(TrainingDbContext db, TimeProvider time)
{
    private const int MaxAttempts = 8;

    public async Task<SetExerciseStepResult> HandleAsync(SetExerciseStepCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var now = TimeStamps.ToStorage(time.GetUtcNow());
        if (LastWriterWins.IsClockAhead(command.ClientUpdatedAt, now))
        {
            return new SetExerciseStepResult(SetStepOutcome.ClockAhead);
        }

        var userId = command.UserId;
        var exercise = await db.Exercises.AsNoTracking()
            .SingleOrDefaultAsync(e => e.Id == command.ExerciseId && (e.OwnerUserId == null || e.OwnerUserId == userId), cancellationToken);
        if (exercise is null)
        {
            return new SetExerciseStepResult(SetStepOutcome.NotFound);
        }

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var choice = await db.ExerciseOverrides
                .SingleOrDefaultAsync(o => o.UserId == userId && o.ExerciseId == command.ExerciseId, cancellationToken);

            if (choice is null)
            {
                choice = new ExerciseOverride
                {
                    UserId = userId,
                    ExerciseId = command.ExerciseId,
                    StepKg = command.StepKg,
                    ClientUpdatedAt = command.ClientUpdatedAt,
                    UpdatedAt = now,
                };
                db.ExerciseOverrides.Add(choice);
            }
            else if (!LastWriterWins.ShouldApply(command.ClientUpdatedAt, choice.ClientUpdatedAt)
                || (choice.ClientUpdatedAt == command.ClientUpdatedAt && choice.StepKg == command.StepKg))
            {
                return new SetExerciseStepResult(SetStepOutcome.Ok, ExerciseResponse.From(exercise, choice));
            }
            else
            {
                choice.StepKg = command.StepKg;
                choice.ClientUpdatedAt = command.ClientUpdatedAt;
                choice.UpdatedAt = now;
            }

            try
            {
                await db.SaveChangesAsync(cancellationToken);
                return new SetExerciseStepResult(SetStepOutcome.Ok, ExerciseResponse.From(exercise, choice));
            }
            catch (DbUpdateConcurrencyException)
            {
                db.ChangeTracker.Clear();
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                db.ChangeTracker.Clear();
            }
        }

        throw new InvalidOperationException("Não foi possível gravar o salto de carga: muitas escritas concorrentes.");
    }
}
