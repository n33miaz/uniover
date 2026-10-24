using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Routines;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Routines.UpsertRoutine;

/// <summary>
/// Cria, edita ou apaga (por lápide) a rotina do usuário, com a rotina inteira num pedido só. O handler é idempotente
/// pelo id, com ou sem o filtro de <c>Idempotency-Key</c>: o reenvio do mesmo pedido não muda nada, e dois envios
/// simultâneos do mesmo id terminam numa rotina só (a unicidade decide; quem perde relê e aplica a regra do último a
/// escrever). Os itens são trocados na mesma gravação do cabeçalho, então ninguém vê a rotina pela metade.
/// </summary>
internal sealed class UpsertRoutineHandler(TrainingDbContext db, CatalogSeeder seeder, TimeProvider time)
{
    // Cada rodada perdida significa que outra escrita ganhou; com conteúdo igual a segunda rodada já encerra sem gravar.
    private const int MaxAttempts = 8;

    public async Task<UpsertRoutineResult> HandleAsync(UpsertRoutineCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var now = TimeStamps.ToStorage(time.GetUtcNow());
        if (LastWriterWins.IsClockAhead(command.ClientUpdatedAt, now))
        {
            return new UpsertRoutineResult(UpsertRoutineOutcome.ClockAhead);
        }

        // A ordem e as superséries só valem para a rotina viva: na lápide os itens ficam como estavam.
        var items = RoutineRules.Arrange(command.Items);
        if (!command.Deleted)
        {
            if (!RoutineRules.SupersetsAreContiguous(items))
            {
                return new UpsertRoutineResult(UpsertRoutineOutcome.SupersetNotContiguous);
            }

            items = RoutineRules.NormalizeSupersets(items);
            if (!await ExercisesExistAsync(items, command.UserId, cancellationToken))
            {
                return new UpsertRoutineResult(UpsertRoutineOutcome.ExerciseNotFound);
            }
        }

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var row = await db.Set<Routine>().Include(r => r.Items).SingleOrDefaultAsync(r => r.Id == command.Id, cancellationToken);
            if (row is null)
            {
                row = new Routine { Id = command.Id, UserId = command.UserId, CreatedAt = now };
                Apply(row, command, items, now);
                db.Set<Routine>().Add(row);
            }
            else if (row.UserId != command.UserId)
            {
                // A rotina de outra pessoa não existe para este usuário (e a resposta não diz que existe).
                return new UpsertRoutineResult(UpsertRoutineOutcome.NotFound);
            }
            else if (!LastWriterWins.ShouldApply(command.ClientUpdatedAt, row.ClientUpdatedAt) || IsSame(row, command, items))
            {
                // Escrita mais velha (ou reenvio idêntico): vale o que já está guardado.
                return new UpsertRoutineResult(UpsertRoutineOutcome.Ok, RoutineResponse.From(row));
            }
            else
            {
                Apply(row, command, items, now);
            }

            try
            {
                await db.SaveChangesAsync(cancellationToken);
                return new UpsertRoutineResult(UpsertRoutineOutcome.Ok, RoutineResponse.From(row));
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

        throw new InvalidOperationException("Não foi possível gravar a rotina: muitas escritas concorrentes no mesmo registro.");
    }

    /// <summary>
    /// Todo exercício precisa existir e ser visível ao usuário: do catálogo ou dele mesmo. O de outra pessoa conta como
    /// inexistente. O exercício próprio apagado (lápide) ainda vale: senão apagar num aparelho faria o pedido de outro
    /// aparelho falhar para sempre na fila.
    /// </summary>
    private async Task<bool> ExercisesExistAsync(IReadOnlyList<RoutineItemSpec> items, Guid userId, CancellationToken cancellationToken)
    {
        var ids = items.Select(i => i.ExerciseId).Distinct().ToList();
        if (ids.Count == 0)
        {
            return true;
        }

        if (await CountVisibleAsync(ids, userId, cancellationToken) == ids.Count)
        {
            return true;
        }

        // O catálogo é carregado de forma preguiçosa: num banco novo os exercícios da semente ainda não existem. Só nesse
        // caso (falta algum) a semente é garantida e a conta refeita.
        await seeder.EnsureSeededAsync(cancellationToken);
        return await CountVisibleAsync(ids, userId, cancellationToken) == ids.Count;
    }

    private Task<int> CountVisibleAsync(List<Guid> ids, Guid userId, CancellationToken cancellationToken) =>
        db.Exercises.AsNoTracking()
            .CountAsync(e => ids.Contains(e.Id) && (e.OwnerUserId == null || e.OwnerUserId == userId), cancellationToken);

    private void Apply(Routine row, UpsertRoutineCommand command, IReadOnlyList<RoutineItemSpec> items, DateTimeOffset now)
    {
        row.Name = command.Name;
        row.Position = command.Position;
        row.Active = command.Active;
        row.Note = command.Note;
        // Programa e dias só mudam quando o pedido os traz: um aparelho antigo, que não os conhece, não os apaga.
        if (command.ProgramId is not null) row.ProgramId = command.ProgramId;
        if (command.Weekdays is not null) row.Weekdays = command.Weekdays;
        row.ClientUpdatedAt = command.ClientUpdatedAt;
        row.UpdatedAt = now;

        // Lápide: a linha fica (outro aparelho precisa saber que a rotina foi apagada); a exclusão é reversível por um
        // PUT mais novo com deleted=false.
        row.DeletedAt = command.Deleted ? now : null;

        if (!command.Deleted)
        {
            ReplaceItems(row, items);
        }
    }

    /// <summary>
    /// Troca os itens comparando por id (e não apaga tudo para inserir de novo): o que continua é atualizado, o que é novo
    /// entra, o que sumiu do corpo some do banco. Tudo na mesma gravação do cabeçalho.
    /// </summary>
    private void ReplaceItems(Routine row, IReadOnlyList<RoutineItemSpec> items)
    {
        var incoming = items.ToDictionary(i => i.Id);

        foreach (var stale in row.Items.Where(i => !incoming.ContainsKey(i.Id)).ToList())
        {
            row.Items.Remove(stale);
            if (db.Entry(stale).State != EntityState.Detached)
            {
                db.Set<RoutineItem>().Remove(stale);
            }
        }

        var current = row.Items.ToDictionary(i => i.Id);
        foreach (var spec in items)
        {
            if (current.TryGetValue(spec.Id, out var existing))
            {
                CopyTo(existing, spec);
                continue;
            }

            // Item novo: em rotina nova o grafo inteiro é adicionado junto com ela; em rotina já guardada o item é
            // adicionado explicitamente (a chave vem do aparelho e o EF não a trata como "ainda sem valor").
            var created = new RoutineItem { RoutineId = row.Id, Id = spec.Id };
            CopyTo(created, spec);
            row.Items.Add(created);
            if (db.Entry(row).State != EntityState.Detached)
            {
                db.Set<RoutineItem>().Add(created);
            }
        }
    }

    private static void CopyTo(RoutineItem item, RoutineItemSpec spec)
    {
        item.ExerciseId = spec.ExerciseId;
        item.Position = spec.Position;
        item.TargetSets = spec.TargetSets;
        item.RepMin = spec.RepMin;
        item.RepMax = spec.RepMax;
        item.RestSeconds = spec.RestSeconds;
        item.SupersetGroup = spec.SupersetGroup;
        item.Note = spec.Note;
    }

    private static bool IsSame(Routine row, UpsertRoutineCommand command, IReadOnlyList<RoutineItemSpec> items)
    {
        var header = row.ClientUpdatedAt == command.ClientUpdatedAt
            && row.IsDeleted == command.Deleted
            && row.Name == command.Name
            && row.Position == command.Position
            && row.Active == command.Active
            && row.Note == command.Note
            && (command.ProgramId is null || row.ProgramId == command.ProgramId)
            && (command.Weekdays is null || row.Weekdays.SequenceEqual(command.Weekdays));
        if (!header)
        {
            return false;
        }

        if (command.Deleted)
        {
            return true;
        }

        var stored = row.Items.OrderBy(i => i.Position).ToList();
        return stored.Count == items.Count && stored.Zip(items).All(pair => SameItem(pair.First, pair.Second));
    }

    private static bool SameItem(RoutineItem item, RoutineItemSpec spec) =>
        item.Id == spec.Id
        && item.ExerciseId == spec.ExerciseId
        && item.Position == spec.Position
        && item.TargetSets == spec.TargetSets
        && item.RepMin == spec.RepMin
        && item.RepMax == spec.RepMax
        && item.RestSeconds == spec.RestSeconds
        && item.SupersetGroup == spec.SupersetGroup
        && item.Note == spec.Note;
}
