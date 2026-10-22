using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Body;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Body.UpsertBodyEntry;

/// <summary>
/// Cria, edita ou apaga (por lápide) a medição do usuário. É idempotente pelo id, com ou sem o filtro de
/// <c>Idempotency-Key</c>: o reenvio não muda nada, e dois envios simultâneos do mesmo id terminam numa linha só (a chave
/// primária decide; quem perde relê e aplica o último a escrever). O servidor não calcula nada de saúde: guarda o que o
/// aparelho mandou, com o método da gordura. A lápide esvazia os valores: o dono apagou, não há por que mantê-los.
/// </summary>
internal sealed class UpsertBodyEntryHandler(TrainingDbContext db, TimeProvider time)
{
    // Cada rodada perdida significa que outra escrita ganhou; com conteúdo igual a segunda rodada já encerra sem gravar.
    private const int MaxAttempts = 8;

    public async Task<UpsertBodyEntryResult> HandleAsync(UpsertBodyEntryCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var now = TimeStamps.ToStorage(time.GetUtcNow());
        if (LastWriterWins.IsClockAhead(command.ClientUpdatedAt, now))
        {
            return new UpsertBodyEntryResult(UpsertBodyEntryOutcome.ClockAhead);
        }

        // Medição viva sem valor nenhum não tem o que guardar. A lápide pode vir vazia: o aparelho que apagou pode nem ter
        // chegado a enviar a medição.
        if (!command.Deleted && !command.HasAnyValue)
        {
            return new UpsertBodyEntryResult(UpsertBodyEntryOutcome.Empty);
        }

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var row = await db.Set<BodyEntry>().SingleOrDefaultAsync(e => e.Id == command.Id, cancellationToken);
            if (row is null)
            {
                row = new BodyEntry { Id = command.Id, UserId = command.UserId, CreatedAt = now };
                Apply(row, command, now);
                db.Set<BodyEntry>().Add(row);
            }
            else if (row.UserId != command.UserId)
            {
                // A medição de outra pessoa não existe para este usuário (e a resposta não diz que existe).
                return new UpsertBodyEntryResult(UpsertBodyEntryOutcome.NotFound);
            }
            else if (!LastWriterWins.ShouldApply(command.ClientUpdatedAt, row.ClientUpdatedAt) || IsSame(row, command))
            {
                // Escrita mais velha (ou reenvio idêntico): vale o que já está guardado.
                return new UpsertBodyEntryResult(UpsertBodyEntryOutcome.Ok, BodyEntryResponse.From(row));
            }
            else
            {
                Apply(row, command, now);
            }

            try
            {
                await db.SaveChangesAsync(cancellationToken);
                return new UpsertBodyEntryResult(UpsertBodyEntryOutcome.Ok, BodyEntryResponse.From(row));
            }
            catch (DbUpdateConcurrencyException)
            {
                db.ChangeTracker.Clear();
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                // Id repetido (outra escrita da mesma medição ganhou): relê e decide de novo; a próxima rodada aplica o
                // último a escrever.
                db.ChangeTracker.Clear();
            }
        }

        throw new InvalidOperationException("Não foi possível gravar a medição: muitas escritas concorrentes no mesmo registro.");
    }

    private static void Apply(BodyEntry row, UpsertBodyEntryCommand command, DateTimeOffset now)
    {
        row.MeasuredOn = command.MeasuredOn;

        // Lápide: a linha fica (outro aparelho precisa saber que a medição foi apagada), sem os valores; reversível por um
        // PUT mais novo, que sempre leva a medição inteira.
        var keep = !command.Deleted;
        row.WeightKg = keep ? command.WeightKg : null;
        row.BodyFatPct = keep ? command.BodyFatPct : null;
        row.FatMethod = keep ? command.FatMethod : null;
        row.WaistCm = keep ? command.WaistCm : null;
        row.NeckCm = keep ? command.NeckCm : null;
        row.HipCm = keep ? command.HipCm : null;
        row.ArmCm = keep ? command.ArmCm : null;
        row.ThighCm = keep ? command.ThighCm : null;
        row.Note = keep ? command.Note : null;
        row.DeletedAt = command.Deleted ? now : null;
        row.ClientUpdatedAt = command.ClientUpdatedAt;
        row.UpdatedAt = now;
    }

    private static bool IsSame(BodyEntry row, UpsertBodyEntryCommand command)
    {
        if (row.ClientUpdatedAt != command.ClientUpdatedAt || row.IsDeleted != command.Deleted || row.MeasuredOn != command.MeasuredOn)
        {
            return false;
        }

        return command.Deleted
            || (row.WeightKg == command.WeightKg
                && row.BodyFatPct == command.BodyFatPct
                && row.FatMethod == command.FatMethod
                && row.WaistCm == command.WaistCm
                && row.NeckCm == command.NeckCm
                && row.HipCm == command.HipCm
                && row.ArmCm == command.ArmCm
                && row.ThighCm == command.ThighCm
                && row.Note == command.Note);
    }
}
