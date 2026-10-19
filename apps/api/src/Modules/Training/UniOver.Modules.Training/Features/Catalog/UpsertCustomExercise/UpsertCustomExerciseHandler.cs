using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Catalog.UpsertCustomExercise;

/// <summary>
/// Cria, edita ou apaga (por lápide) o exercício próprio do usuário. O handler é idempotente pelo id, com ou sem o filtro
/// de <c>Idempotency-Key</c>: o reenvio do mesmo pedido não muda nada e dois envios simultâneos do mesmo id terminam numa
/// linha só (a unicidade decide; quem perde relê e aplica a regra do último a escrever).
/// </summary>
internal sealed class UpsertCustomExerciseHandler(TrainingDbContext db, TimeProvider time)
{
    // Cada rodada perdida significa que outra escrita ganhou; com conteúdo igual a segunda rodada já encerra sem gravar.
    private const int MaxAttempts = 8;

    public async Task<UpsertCustomExerciseResult> HandleAsync(UpsertCustomExerciseCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var now = TimeStamps.ToStorage(time.GetUtcNow());
        if (LastWriterWins.IsClockAhead(command.ClientUpdatedAt, now))
        {
            return new UpsertCustomExerciseResult(UpsertOutcome.ClockAhead);
        }

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var row = await db.Exercises.SingleOrDefaultAsync(e => e.Id == command.Id, cancellationToken);
            if (row is null)
            {
                row = Create(command, now);
                db.Exercises.Add(row);
            }
            else if (row.IsCatalog)
            {
                return new UpsertCustomExerciseResult(UpsertOutcome.CatalogReadonly);
            }
            else if (row.OwnerUserId != command.UserId)
            {
                // O exercício de outra pessoa não existe para este usuário.
                return new UpsertCustomExerciseResult(UpsertOutcome.NotFound);
            }
            else if (!LastWriterWins.ShouldApply(command.ClientUpdatedAt, row.ClientUpdatedAt) || IsSame(row, command))
            {
                // Escrita mais velha (ou reenvio idêntico): vale o que já está guardado.
                return await RespondAsync(row, command.UserId, cancellationToken);
            }
            else
            {
                Apply(row, command, now);
            }

            try
            {
                await db.SaveChangesAsync(cancellationToken);
                return await RespondAsync(row, command.UserId, cancellationToken);
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

        throw new InvalidOperationException("Não foi possível gravar o exercício: muitas escritas concorrentes no mesmo registro.");
    }

    private async Task<UpsertCustomExerciseResult> RespondAsync(Exercise row, Guid userId, CancellationToken cancellationToken)
    {
        var choice = await db.ExerciseOverrides.AsNoTracking()
            .SingleOrDefaultAsync(o => o.UserId == userId && o.ExerciseId == row.Id, cancellationToken);
        return new UpsertCustomExerciseResult(UpsertOutcome.Ok, ExerciseResponse.From(row, choice));
    }

    private static Exercise Create(UpsertCustomExerciseCommand command, DateTimeOffset now)
    {
        var row = new Exercise
        {
            Id = command.Id,
            Source = ExerciseSources.Own,
            OwnerUserId = command.UserId,
            CreatedAt = now,
        };
        Apply(row, command, now);
        return row;
    }

    private static void Apply(Exercise row, UpsertCustomExerciseCommand command, DateTimeOffset now)
    {
        row.Name = command.Name;
        row.Slug = TextNormalizer.SlugWithId(command.Name, command.Id);
        row.Instructions = [.. command.Instructions];
        row.PrimaryMuscles = [.. command.PrimaryMuscles];
        row.SecondaryMuscles = [.. command.SecondaryMuscles];
        row.Equipment = command.Equipment;
        row.RecordType = command.RecordType;
        row.StepKg = command.StepKg;
        row.Reviewed = true;
        row.ClientUpdatedAt = command.ClientUpdatedAt;
        row.UpdatedAt = now;

        // Lápide: a linha fica (outro aparelho precisa saber que o exercício foi apagado); a exclusão é reversível por um
        // PUT mais novo com deleted=false.
        row.DeletedAt = command.Deleted ? now : null;
    }

    private static bool IsSame(Exercise row, UpsertCustomExerciseCommand command) =>
        row.ClientUpdatedAt == command.ClientUpdatedAt
        && row.IsDeleted == command.Deleted
        && row.Name == command.Name
        && row.Equipment == command.Equipment
        && row.RecordType == command.RecordType
        && row.StepKg == command.StepKg
        && row.PrimaryMuscles.SequenceEqual(command.PrimaryMuscles, StringComparer.Ordinal)
        && row.SecondaryMuscles.SequenceEqual(command.SecondaryMuscles, StringComparer.Ordinal)
        && row.Instructions.SequenceEqual(command.Instructions, StringComparer.Ordinal);
}
