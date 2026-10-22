using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Body;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Body.UpsertBodyProfile;

/// <summary>
/// Grava ou troca o perfil do usuário, achando-o pela chave natural (o próprio usuário). É idempotente com ou sem o filtro
/// de <c>Idempotency-Key</c>: o reenvio não muda nada, e pedidos simultâneos terminam numa linha só (a chave primária
/// decide; quem perde relê e aplica o último a escrever). Não há lápide: o perfil só troca de valor.
/// </summary>
internal sealed class UpsertBodyProfileHandler(TrainingDbContext db, TimeProvider time)
{
    // Cada rodada perdida significa que outra escrita ganhou; com conteúdo igual a segunda rodada já encerra sem gravar.
    private const int MaxAttempts = 8;

    public async Task<UpsertBodyProfileResult> HandleAsync(UpsertBodyProfileCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var now = TimeStamps.ToStorage(time.GetUtcNow());
        if (LastWriterWins.IsClockAhead(command.ClientUpdatedAt, now))
        {
            return new UpsertBodyProfileResult(UpsertBodyProfileOutcome.ClockAhead);
        }

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var userId = command.UserId;
            var row = await db.Set<BodyProfile>().SingleOrDefaultAsync(p => p.UserId == userId, cancellationToken);
            if (row is null)
            {
                row = new BodyProfile { UserId = command.UserId, CreatedAt = now };
                Apply(row, command, now);
                db.Set<BodyProfile>().Add(row);
            }
            else if (!LastWriterWins.ShouldApply(command.ClientUpdatedAt, row.ClientUpdatedAt) || IsSame(row, command))
            {
                // Escrita mais velha (ou reenvio idêntico): vale o que já está guardado.
                return new UpsertBodyProfileResult(UpsertBodyProfileOutcome.Ok, BodyProfileResponse.From(row));
            }
            else
            {
                Apply(row, command, now);
            }

            try
            {
                await db.SaveChangesAsync(cancellationToken);
                return new UpsertBodyProfileResult(UpsertBodyProfileOutcome.Ok, BodyProfileResponse.From(row));
            }
            catch (DbUpdateConcurrencyException)
            {
                db.ChangeTracker.Clear();
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                // Outra escrita criou o perfil no mesmo instante: relê pela chave natural e decide de novo.
                db.ChangeTracker.Clear();
            }
        }

        throw new InvalidOperationException("Não foi possível gravar o perfil: muitas escritas concorrentes.");
    }

    private static void Apply(BodyProfile row, UpsertBodyProfileCommand command, DateTimeOffset now)
    {
        row.HeightCm = command.HeightCm;
        row.BirthDate = command.BirthDate;
        row.Sex = command.Sex;
        row.ActivityFactor = command.ActivityFactor;
        row.ClientUpdatedAt = command.ClientUpdatedAt;
        row.UpdatedAt = now;
    }

    private static bool IsSame(BodyProfile row, UpsertBodyProfileCommand command) =>
        row.ClientUpdatedAt == command.ClientUpdatedAt
        && row.HeightCm == command.HeightCm
        && row.BirthDate == command.BirthDate
        && row.Sex == command.Sex
        && row.ActivityFactor == command.ActivityFactor;
}
