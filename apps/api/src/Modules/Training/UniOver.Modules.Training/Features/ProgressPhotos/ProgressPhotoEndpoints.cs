using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using System.Data.Common;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Persistence;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Training.Ports;

namespace UniOver.Modules.Training.Features.ProgressPhotos;

internal static class ProgressPhotoEndpoints
{
    public static void MapProgressPhotos(this IEndpointRouteBuilder group)
    {
        group.MapGet("/progress-photos", ListAsync).RequireAuthorization(TrainingAuth.Module)
            .Produces<IReadOnlyList<ProgressPhotoResponse>>().ProducesProblem(401).ProducesProblem(503);
        // O corpo é o JPEG cru (sem Accepts: uma rota com tipo de corpo declarado devolve a recusa de tipo sem a política
        // da rota, e quem não é administrador veria 403 em vez de 415); o tipo é conferido à mão, como na importação da TACO.
        group.MapPut("/progress-photos/{id:guid}", PutAsync).RequireAuthorization(TrainingAuth.Module)
            // Teto de corpo da rota: o do JPEG mais uma folga, para a própria resposta de 413 desta rota (com a mensagem da foto) valer
            // antes do teto geral da API (256 KiB).
            .WithMetadata(new RequestSizeLimitAttribute(JpegPhotoValidator.MaxBytes + 16 * 1024))
            .RequireRateLimiting(RateLimitPolicies.Commands).DisableAntiforgery()
            .Produces<ProgressPhotoResponse>().ProducesProblem(400)
            .ProducesProblem(401).ProducesProblem(403).ProducesProblem(404).ProducesProblem(409).ProducesProblem(413)
            .ProducesProblem(415).ProducesProblem(503);
        group.MapGet("/progress-photos/{id:guid}/content", ReadAsync).RequireAuthorization(TrainingAuth.Module)
            .Produces(StatusCodes.Status200OK, contentType: "image/jpeg").ProducesProblem(401).ProducesProblem(403).ProducesProblem(404).ProducesProblem(503);
        // Apagar é um PUT com lápide, como no resto do módulo (nenhuma rota DELETE): idempotente, sem corpo.
        group.MapPut("/progress-photos/{id:guid}/deletion", DeleteAsync).RequireAuthorization(TrainingAuth.Module)
            .RequireRateLimiting(RateLimitPolicies.Commands).Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(401).ProducesProblem(403).ProducesProblem(503);
    }

    private static async Task<IResult> ListAsync(ICurrentUser current, IProgressPhotoObjectStore store, ProgressPhotoHandler handler, ISystemSettings settings, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId) return Results.Problem(statusCode: 401, title: "Sessão inválida ou expirada.");
        if (!await settings.PhotoStorageEnabledAsync(cancellationToken) || !store.IsAvailable) return StorageDisabled();
        try { return Results.Ok(await handler.ListAsync(userId, cancellationToken)); }
        catch (Exception exception) when (exception is DbException or InvalidOperationException) { return StorageUnavailable(); }
    }

    private static async Task<IResult> PutAsync(Guid id, [FromQuery] DateOnly? takenOn, HttpRequest request, ICurrentUser current, IProgressPhotoObjectStore store, ProgressPhotoHandler handler, ISystemSettings settings, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId) return Results.Problem(statusCode: 401, title: "Sessão inválida ou expirada.");
        if (!await settings.PhotoStorageEnabledAsync(cancellationToken) || !store.IsAvailable) return StorageDisabled();
        var mediaType = request.ContentType?.Split(';', 2)[0].Trim();
        if (!string.Equals(mediaType, "image/jpeg", StringComparison.OrdinalIgnoreCase))
            return Results.Problem(statusCode: 415, title: "Envie uma foto JPEG (image/jpeg).");
        if (takenOn is null)
            return Results.Problem(statusCode: 400, title: "Informe a data da foto em takenOn.");

        if (request.ContentLength > JpegPhotoValidator.MaxBytes)
            return Results.Problem(statusCode: 413, title: "A foto excede o limite de 5 MB.");
        var bytes = await ReadBoundedAsync(request.Body, JpegPhotoValidator.MaxBytes, cancellationToken);
        if (bytes is null) return Results.Problem(statusCode: 413, title: "A foto excede o limite de 5 MB.");
        try
        {
            var result = await handler.PutAsync(userId, id, takenOn.Value, bytes, cancellationToken);
            return result.Status switch
            {
                ProgressPhotoWriteStatus.Ok => Results.Ok(result.Photo),
                ProgressPhotoWriteStatus.Invalid => Results.Problem(statusCode: 400, title: "A foto deve ser um JPEG válido de até 1280 px por lado."),
                ProgressPhotoWriteStatus.Conflict => Results.Problem(statusCode: 409, title: "Este identificador já foi usado por outra foto."),
                ProgressPhotoWriteStatus.QuotaExceeded => Results.Problem(statusCode: 413, title: "A conta atingiu o limite de fotos de progresso."),
                _ => Results.Problem(statusCode: 404, title: "Foto não encontrada."),
            };
        }
        catch (Exception exception) when (exception is Amazon.Runtime.AmazonServiceException or DbException or DbUpdateException or IOException or InvalidOperationException)
        { return StorageUnavailable(); }
    }

    private static async Task<IResult> ReadAsync(Guid id, ICurrentUser current, IProgressPhotoObjectStore store, ProgressPhotoHandler handler, ISystemSettings settings, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId) return Results.Problem(statusCode: 401, title: "Sessão inválida ou expirada.");
        if (!await settings.PhotoStorageEnabledAsync(cancellationToken) || !store.IsAvailable) return StorageDisabled();
        try
        {
            var result = await handler.ReadAsync(userId, id, cancellationToken);
            if (result.Content is null) return Results.Problem(statusCode: 404, title: "Foto não encontrada.");
            // Cache-Control: no-store e nosniff já saem em toda resposta da API (SecurityHeaders).
            return Results.Stream(result.Content, "image/jpeg");
        }
        catch (Exception exception) when (exception is Amazon.Runtime.AmazonServiceException or DbException or DbUpdateException or IOException or InvalidOperationException)
        { return StorageUnavailable(); }
    }

    private static async Task<IResult> DeleteAsync(Guid id, ICurrentUser current, IProgressPhotoObjectStore store, ProgressPhotoHandler handler, ISystemSettings settings, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId) return Results.Problem(statusCode: 401, title: "Sessão inválida ou expirada.");
        if (!await settings.PhotoStorageEnabledAsync(cancellationToken) || !store.IsAvailable) return StorageDisabled();
        try
        {
            var status = await handler.DeleteAsync(userId, id, cancellationToken);
            return status == ProgressPhotoWriteStatus.Ok ? Results.NoContent() : Results.Problem(statusCode: 404);
        }
        catch (Exception exception) when (exception is Amazon.Runtime.AmazonServiceException or DbException or DbUpdateException or IOException or InvalidOperationException)
        { return StorageUnavailable(); }
    }

    private static async Task<byte[]?> ReadBoundedAsync(Stream stream, int maxBytes, CancellationToken cancellationToken)
    {
        await using var output = new MemoryStream();
        var buffer = new byte[32 * 1024];
        while (true)
        {
            var read = await stream.ReadAsync(buffer, cancellationToken);
            if (read == 0) return output.ToArray();
            if (output.Length + read > maxBytes) return null;
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
    }

    private const string StorageDisabledType = "progress-photo-storage-disabled";
    private const string StorageUnavailableType = "progress-photo-storage-unavailable";

    /// <summary>Sem bucket configurado no servidor: não é falha, é o modo "só no aparelho"; o cliente mantém as fotos locais e não repete.</summary>
    private static IResult StorageDisabled() => Results.Problem(
        statusCode: 503,
        title: "As fotos de progresso ficam só neste aparelho: o armazenamento na nuvem não está configurado no servidor.",
        type: ProblemDetailsExtensions.TypeBase + StorageDisabledType);

    private static IResult StorageUnavailable() => Results.Problem(
        statusCode: 503,
        title: "O armazenamento de fotos está indisponível. Tente de novo mais tarde.",
        type: ProblemDetailsExtensions.TypeBase + StorageUnavailableType);
}
