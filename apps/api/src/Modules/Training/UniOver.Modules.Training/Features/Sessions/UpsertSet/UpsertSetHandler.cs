using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Sessions;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Sessions.UpsertSet;

/// <summary>
/// Cria, edita ou apaga (por lápide) uma série do treino. É idempotente pelo id, com ou sem o filtro de
/// <c>Idempotency-Key</c>; dois envios simultâneos do mesmo id terminam numa linha só (quem perde relê e aplica o último a
/// escrever). A série de um treino já apagado entra (ou fica) como lápide: o apagamento vale, e o pedido que ainda estava
/// na fila de outro aparelho não falha para sempre.
/// </summary>
internal sealed class UpsertSetHandler(TrainingDbContext db, CatalogSeeder seeder, TimeProvider time)
{
    private const int MaxAttempts = 8;

    public async Task<UpsertSetResult> HandleAsync(UpsertSetCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var now = TimeStamps.ToStorage(time.GetUtcNow());
        if (LastWriterWins.IsClockAhead(command.ClientUpdatedAt, now))
        {
            return new UpsertSetResult(UpsertSetOutcome.ClockAhead);
        }

        // Treino de outra pessoa (ou que nunca chegou) é "não encontrado"; a fila mostra a falha em vez de perder a série.
        // A confirmação do estado fica dentro da trava abaixo: entre esta leitura e a gravação o treino pode ser apagado.
        if (!await db.Set<Session>().AsNoTracking()
            .AnyAsync(s => s.Id == command.SessionId && s.UserId == command.UserId, cancellationToken))
        {
            return new UpsertSetResult(UpsertSetOutcome.SessionNotFound);
        }

        var recordType = await FindRecordTypeAsync(command.ExerciseId, command.UserId, cancellationToken);
        if (recordType is null)
        {
            return new UpsertSetResult(UpsertSetOutcome.ExerciseNotFound);
        }

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
            // A lápide da sessão e as séries dela compartilham esta trava. Depois de esperar, a leitura vê o apagamento
            // confirmado e não deixa uma série viva voltar no pull incremental.
            var session = await db.Set<Session>()
                .FromSqlInterpolated($"SELECT * FROM training.sessions WHERE id = {command.SessionId} AND user_id = {command.UserId} FOR UPDATE")
                .AsNoTracking()
                .SingleOrDefaultAsync(cancellationToken);
            if (session is null)
            {
                return new UpsertSetResult(UpsertSetOutcome.SessionNotFound);
            }

            var dead = command.Deleted || session.IsDeleted;
            if (!dead && !SetRules.HasValidShape(recordType, command.SetType, command.WeightKg, command.Reps, command.DurationS))
            {
                return new UpsertSetResult(UpsertSetOutcome.ShapeInvalid);
            }

            var row = await db.Set<SessionSet>().SingleOrDefaultAsync(s => s.Id == command.Id, cancellationToken);
            if (row is null)
            {
                row = new SessionSet { Id = command.Id, UserId = command.UserId, SessionId = command.SessionId, CreatedAt = now };
                Apply(row, command, dead, now);
                db.Set<SessionSet>().Add(row);
            }
            else if (row.UserId != command.UserId || row.SessionId != command.SessionId)
            {
                // A série de outra pessoa (ou de outro treino) não existe para este pedido, e a resposta não diz que existe.
                return new UpsertSetResult(UpsertSetOutcome.SessionNotFound);
            }
            else if (!LastWriterWins.ShouldApply(command.ClientUpdatedAt, row.ClientUpdatedAt) || IsSame(row, command, dead))
            {
                // Escrita mais velha (ou reenvio idêntico): vale o que já está guardado.
                return new UpsertSetResult(UpsertSetOutcome.Ok, SetResponse.From(row));
            }
            else
            {
                Apply(row, command, dead, now);
            }

            try
            {
                await db.SaveChangesAsync(cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                return new UpsertSetResult(UpsertSetOutcome.Ok, SetResponse.From(row));
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

        throw new InvalidOperationException("Não foi possível gravar a série: muitas escritas concorrentes no mesmo registro.");
    }

    /// <summary>
    /// O exercício precisa existir e ser visível ao usuário (do catálogo ou dele; o de outra pessoa conta como inexistente).
    /// O próprio apagado ainda vale, como nas rotinas. O catálogo é carregado de forma preguiçosa: só quando o exercício
    /// não aparece a semente é garantida e a busca refeita.
    /// </summary>
    private async Task<string?> FindRecordTypeAsync(Guid exerciseId, Guid userId, CancellationToken cancellationToken)
    {
        var found = await QueryRecordTypeAsync(exerciseId, userId, cancellationToken);
        if (found is not null)
        {
            return found;
        }

        await seeder.EnsureSeededAsync(cancellationToken);
        return await QueryRecordTypeAsync(exerciseId, userId, cancellationToken);
    }

    private Task<string?> QueryRecordTypeAsync(Guid exerciseId, Guid userId, CancellationToken cancellationToken) =>
        db.Exercises.AsNoTracking()
            .Where(e => e.Id == exerciseId && (e.OwnerUserId == null || e.OwnerUserId == userId))
            .Select(e => e.RecordType)
            .SingleOrDefaultAsync(cancellationToken);

    private static void Apply(SessionSet row, UpsertSetCommand command, bool dead, DateTimeOffset now)
    {
        row.ExerciseId = command.ExerciseId;
        row.Position = command.Position;
        row.SetType = command.SetType;
        row.WeightKg = command.WeightKg;
        row.Reps = command.Reps;
        row.DurationS = command.DurationS;
        row.Rir = command.Rir;
        row.Rpe = command.Rpe;
        row.Note = command.Note;
        row.CompletedAt = command.CompletedAt;
        row.ClientUpdatedAt = command.ClientUpdatedAt;
        row.UpdatedAt = now;

        // Lápide: a linha fica (outro aparelho precisa saber que a série foi apagada); reversível por um PUT mais novo.
        row.DeletedAt = dead ? now : null;
    }

    private static bool IsSame(SessionSet row, UpsertSetCommand command, bool dead) =>
        row.ClientUpdatedAt == command.ClientUpdatedAt
        && row.IsDeleted == dead
        && row.ExerciseId == command.ExerciseId
        && row.Position == command.Position
        && row.SetType == command.SetType
        && row.WeightKg == command.WeightKg
        && row.Reps == command.Reps
        && row.DurationS == command.DurationS
        && row.Rir == command.Rir
        && row.Rpe == command.Rpe
        && row.Note == command.Note
        && row.CompletedAt == command.CompletedAt;
}
