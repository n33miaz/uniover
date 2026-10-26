using Microsoft.EntityFrameworkCore;
using System.Security.Cryptography;
using UniOver.Modules.Training.Adapters;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Persistence;
using UniOver.Modules.Training.Ports;

namespace UniOver.Modules.Training.Features.ProgressPhotos;

internal sealed record ProgressPhotoResponse(Guid Id, DateOnly TakenOn, int Width, int Height, long ByteLength, DateTimeOffset CreatedAt);
internal enum ProgressPhotoWriteStatus { Ok, Invalid, Conflict, NotFound, QuotaExceeded }
internal sealed record ProgressPhotoWriteResult(ProgressPhotoWriteStatus Status, ProgressPhotoResponse? Photo = null);

internal sealed class ProgressPhotoHandler(TrainingDbContext db, IProgressPhotoObjectStore store, ProgressPhotoOptions options, TimeProvider time)
{
    public async Task<IReadOnlyList<ProgressPhotoResponse>> ListAsync(Guid userId, CancellationToken cancellationToken)
    {
        return await db.Set<ProgressPhoto>().AsNoTracking()
            .Where(photo => photo.UserId == userId && photo.State == "ready")
            .OrderByDescending(photo => photo.TakenOn).ThenByDescending(photo => photo.CreatedAt)
            .Select(photo => ToResponse(photo)).ToListAsync(cancellationToken);
    }

    public async Task<ProgressPhotoWriteResult> PutAsync(Guid userId, Guid id, DateOnly takenOn, byte[] bytes, CancellationToken cancellationToken)
    {
        if (id == Guid.Empty || takenOn < new DateOnly(1900, 1, 1) || takenOn > DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime).AddDays(1) ||
            !JpegPhotoValidator.TryNormalize(bytes, out var jpeg) || jpeg is null)
            return new ProgressPhotoWriteResult(ProgressPhotoWriteStatus.Invalid);

        var existing = await db.Set<ProgressPhoto>().SingleOrDefaultAsync(photo => photo.Id == id, cancellationToken);
        if (existing is null)
        {
            await using var admission = await db.Database.BeginTransactionAsync(cancellationToken);
            // A quota é por conta. Este lock curto evita que uploads paralelos a ultrapassem antes de haver uma linha a bloquear.
            await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtextextended({id.ToString()}, 0))", cancellationToken);
            await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtextextended({userId.ToString()}, 0))", cancellationToken);
            existing = await db.Set<ProgressPhoto>().SingleOrDefaultAsync(photo => photo.Id == id, cancellationToken);
            if (existing is null)
            {
                var active = db.Set<ProgressPhoto>().Where(photo => photo.UserId == userId && photo.State != "deleted");
                var count = await active.CountAsync(cancellationToken);
                var usedBytes = await active.SumAsync(photo => (long?)photo.ByteLength, cancellationToken) ?? 0;
                if (count >= options.MaxAccountPhotos || usedBytes > options.MaxAccountBytes - jpeg.Content.LongLength)
                    return new ProgressPhotoWriteResult(ProgressPhotoWriteStatus.QuotaExceeded);

                existing = new ProgressPhoto
                {
                    Id = id,
                    UserId = userId,
                    TakenOn = takenOn,
                    ObjectKey = CreateObjectKey(),
                    Width = jpeg.Width,
                    Height = jpeg.Height,
                    ByteLength = jpeg.Content.LongLength,
                    Sha256 = jpeg.Sha256,
                    State = "pending",
                    CreatedAt = time.GetUtcNow(),
                };
                db.Add(existing);
                await db.SaveChangesAsync(cancellationToken);
            }
            await admission.CommitAsync(cancellationToken);
        }

        var row = existing!;
        if (row.UserId != userId || row.State == "deleted")
            return new ProgressPhotoWriteResult(ProgressPhotoWriteStatus.NotFound);
        if (row.Sha256 != jpeg.Sha256 || row.TakenOn != takenOn)
            return new ProgressPhotoWriteResult(ProgressPhotoWriteStatus.Conflict);
        if (row.State == "ready") return new ProgressPhotoWriteResult(ProgressPhotoWriteStatus.Ok, ToResponse(row));

        // O lock serializa upload e exclusão. Se a exclusão ganhar, a linha tombstone impede este reenvio de ressuscitar a foto.
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        row = await db.Set<ProgressPhoto>()
            .FromSqlInterpolated($"SELECT * FROM training.progress_photos WHERE id = {id} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken);
        if (row is null || row.UserId != userId || row.State == "deleted")
            return new ProgressPhotoWriteResult(ProgressPhotoWriteStatus.NotFound);
        // A consulta de trava pode devolver a instância pendente já rastreada antes da transação. Recarrega depois de
        // adquirir a trava para não subir o JPEG se a exclusão confirmou a lápide nesse intervalo.
        await db.Entry(row).ReloadAsync(cancellationToken);
        if (row.UserId != userId || row.State == "deleted")
            return new ProgressPhotoWriteResult(ProgressPhotoWriteStatus.NotFound);
        if (row.Sha256 != jpeg.Sha256 || row.TakenOn != takenOn)
            return new ProgressPhotoWriteResult(ProgressPhotoWriteStatus.Conflict);
        if (row.State == "ready") return new ProgressPhotoWriteResult(ProgressPhotoWriteStatus.Ok, ToResponse(row));

        // A linha pendente vem antes do objeto: falha/reinício pode ser retomado com a mesma chave e não deixa lixo sem metadados.
        var objectWritten = false;
        try
        {
            await store.PutAsync(row.ObjectKey, jpeg.Content, cancellationToken);
            objectWritten = true;
            row.State = "ready";
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new ProgressPhotoWriteResult(ProgressPhotoWriteStatus.Ok, ToResponse(row));
        }
        catch
        {
            if (objectWritten)
            {
                // Sem a confirmação de ready, ninguém pode alcançar esse objeto; a compensação evita JPEG de saúde órfão.
                try { await store.DeleteAsync(row.ObjectKey, CancellationToken.None); }
                catch { }
            }

            throw;
        }
    }

    public async Task<(ProgressPhotoWriteStatus Status, Stream? Content)> ReadAsync(Guid userId, Guid id, CancellationToken cancellationToken)
    {
        var row = await db.Set<ProgressPhoto>().AsNoTracking()
            .SingleOrDefaultAsync(photo => photo.Id == id && photo.UserId == userId && photo.State == "ready", cancellationToken);
        if (row is null) return (ProgressPhotoWriteStatus.NotFound, null);
        var content = await store.OpenReadAsync(row.ObjectKey, cancellationToken);
        return content is null ? (ProgressPhotoWriteStatus.NotFound, null) : (ProgressPhotoWriteStatus.Ok, content);
    }

    public async Task<ProgressPhotoWriteStatus> DeleteAsync(Guid userId, Guid id, CancellationToken cancellationToken)
    {
        string? objectKey;
        await using (var transaction = await db.Database.BeginTransactionAsync(cancellationToken))
        {
            var row = await db.Set<ProgressPhoto>()
                .FromSqlInterpolated($"SELECT * FROM training.progress_photos WHERE id = {id} FOR UPDATE")
                .SingleOrDefaultAsync(cancellationToken);
            if (row is null || row.UserId != userId) return ProgressPhotoWriteStatus.Ok;
            objectKey = row.ObjectKey;
            if (row.State != "deleted")
            {
                row.DeletedAt = time.GetUtcNow();
                row.State = "deleted";
                await db.SaveChangesAsync(cancellationToken);
            }
            await transaction.CommitAsync(cancellationToken);
        }
        // A lápide já bloqueia leitura/ressurreição; se o objeto falhar, DELETE repetido tenta apagá-lo de novo.
        await store.DeleteAsync(objectKey, cancellationToken);
        return ProgressPhotoWriteStatus.Ok;
    }

    private static ProgressPhotoResponse ToResponse(ProgressPhoto row) =>
        new(row.Id, row.TakenOn, row.Width, row.Height, row.ByteLength, row.CreatedAt);

    private static string CreateObjectKey() => $"progress-photos/{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32))}.jpg";
}
