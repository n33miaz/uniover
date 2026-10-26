using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Routines;
using UniOver.Modules.Training.Domain.Sessions;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Sessions.UpsertSession;

/// <summary>
/// Cria, edita, encerra ou apaga (por lápide) o treino do usuário. É idempotente pelo id, com ou sem o filtro de
/// <c>Idempotency-Key</c>: o reenvio não muda nada, e dois envios simultâneos do mesmo id terminam numa linha só (a
/// unicidade decide; quem perde relê e aplica o último a escrever).
///
/// Um aparelho por vez: abrir um treino com outro em andamento é recusado (409 <c>session-already-open</c>). A checagem
/// do handler dá a resposta clara; o índice único parcial do banco é a trava para dois aparelhos abrindo no mesmo instante.
/// Apagar o treino apaga as séries dele junto (com <c>updated_at</c> novo, para a leitura incremental propagar).
/// </summary>
internal sealed class UpsertSessionHandler(TrainingDbContext db, TimeProvider time)
{
    // Cada rodada perdida significa que outra escrita ganhou; com conteúdo igual a segunda rodada já encerra sem gravar.
    private const int MaxAttempts = 8;

    public async Task<UpsertSessionResult> HandleAsync(UpsertSessionCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var now = TimeStamps.ToStorage(time.GetUtcNow());
        if (LastWriterWins.IsClockAhead(command.ClientUpdatedAt, now))
        {
            return new UpsertSessionResult(UpsertSessionOutcome.ClockAhead);
        }

        if (command.FinishedAt is { } finished && finished < command.StartedAt)
        {
            return new UpsertSessionResult(UpsertSessionOutcome.FinishBeforeStart);
        }

        // A rotina precisa existir e ser do usuário. A apagada ainda vale: apagar a rotina num aparelho não pode fazer o
        // treino de outro aparelho falhar para sempre na fila.
        if (command.RoutineId is { } routineId
            && !await db.Set<Routine>().AsNoTracking().AnyAsync(r => r.Id == routineId && r.UserId == command.UserId, cancellationToken))
        {
            return new UpsertSessionResult(UpsertSessionOutcome.RoutineNotFound);
        }

        var willBeOpen = command.FinishedAt is null && !command.Deleted;

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
            // A série usa a mesma trava antes de gravar. Assim, quem apagar o treino enxerga toda série que entrou
            // primeiro, e quem chegar depois enxerga a lápide antes de decidir se a série está viva.
            var row = await db.Set<Session>()
                .FromSqlInterpolated($"SELECT * FROM training.sessions WHERE id = {command.Id} FOR UPDATE")
                .SingleOrDefaultAsync(cancellationToken);
            if (row is null)
            {
                if (willBeOpen && await FindOtherOpenAsync(command, cancellationToken) is { } other)
                {
                    return Refused(other);
                }

                row = new Session { Id = command.Id, UserId = command.UserId, CreatedAt = now };
                Apply(row, command, now);
                db.Set<Session>().Add(row);
            }
            else if (row.UserId != command.UserId)
            {
                // O treino de outra pessoa não existe para este usuário (e a resposta não diz que existe).
                return new UpsertSessionResult(UpsertSessionOutcome.NotFound);
            }
            else if (!LastWriterWins.ShouldApply(command.ClientUpdatedAt, row.ClientUpdatedAt) || IsSame(row, command))
            {
                // Escrita mais velha (ou reenvio idêntico): vale o que já está guardado.
                return new UpsertSessionResult(UpsertSessionOutcome.Ok, SessionResponse.From(row));
            }
            else
            {
                if (willBeOpen && !row.IsOpen && await FindOtherOpenAsync(command, cancellationToken) is { } other)
                {
                    return Refused(other);
                }

                Apply(row, command, now);
            }

            if (command.Deleted)
            {
                await TombstoneSetsAsync(command, now, cancellationToken);
            }

            try
            {
                await db.SaveChangesAsync(cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                return new UpsertSessionResult(UpsertSessionOutcome.Ok, SessionResponse.From(row));
            }
            catch (DbUpdateConcurrencyException)
            {
                db.ChangeTracker.Clear();
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                // Id repetido (outra escrita do mesmo treino ganhou) ou segunda sessão aberta no mesmo instante: relê e
                // decide de novo; a próxima rodada ou aplica o último a escrever ou recusa com a sessão que ganhou.
                db.ChangeTracker.Clear();
            }
        }

        throw new InvalidOperationException("Não foi possível gravar o treino: muitas escritas concorrentes no mesmo registro.");
    }

    private static UpsertSessionResult Refused(Session other) =>
        new(UpsertSessionOutcome.AlreadyOpen, Open: new OpenSessionInfo(other.Id, other.DeviceId, other.StartedAt));

    private Task<Session?> FindOtherOpenAsync(UpsertSessionCommand command, CancellationToken cancellationToken) =>
        db.Set<Session>().AsNoTracking()
            .Where(s => s.UserId == command.UserId && s.Id != command.Id && s.FinishedAt == null && s.DeletedAt == null)
            .OrderBy(s => s.StartedAt)
            .FirstOrDefaultAsync(cancellationToken);

    private static void Apply(Session row, UpsertSessionCommand command, DateTimeOffset now)
    {
        row.RoutineId = command.RoutineId;
        row.StartedAt = command.StartedAt;
        row.FinishedAt = command.FinishedAt;
        row.Note = command.Note;
        row.Feeling = command.Feeling;
        row.DeviceId = command.DeviceId;
        row.ClientUpdatedAt = command.ClientUpdatedAt;
        row.UpdatedAt = now;

        // Lápide: a linha fica (outro aparelho precisa saber que o treino foi apagado); reversível por um PUT mais novo.
        row.DeletedAt = command.Deleted ? now : null;
    }

    /// <summary>
    /// As séries do treino apagado viram lápide na mesma gravação, com instante de servidor novo (para o pull entregá-las) e
    /// o relógio de escrita não menor que o da lápide da sessão (para uma edição antiga da série não a ressuscitar).
    /// </summary>
    private async Task TombstoneSetsAsync(UpsertSessionCommand command, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var sets = await db.Set<SessionSet>()
            .Where(s => s.SessionId == command.Id && s.UserId == command.UserId && s.DeletedAt == null)
            .ToListAsync(cancellationToken);
        foreach (var set in sets)
        {
            set.DeletedAt = now;
            set.UpdatedAt = now;
            if (command.ClientUpdatedAt > set.ClientUpdatedAt)
            {
                set.ClientUpdatedAt = command.ClientUpdatedAt;
            }
        }
    }

    private static bool IsSame(Session row, UpsertSessionCommand command) =>
        row.ClientUpdatedAt == command.ClientUpdatedAt
        && row.IsDeleted == command.Deleted
        && row.RoutineId == command.RoutineId
        && row.StartedAt == command.StartedAt
        && row.FinishedAt == command.FinishedAt
        && row.Note == command.Note
        && row.Feeling == command.Feeling
        && row.DeviceId == command.DeviceId;
}
