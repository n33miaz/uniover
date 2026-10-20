using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.UpdateShortcut;

/// <param name="CustomLabel">Nome próprio do atalho; texto vazio apaga e volta a "Atalho n". Ausente = não muda.</param>
/// <param name="Enabled">Mostrar ou esconder o atalho. Ausente = não muda.</param>
internal sealed record UpdateShortcutRequest(string? CustomLabel, bool? Enabled);

internal sealed record UpdateShortcutCommand(Guid ShortcutId, string? CustomLabel, bool? Enabled);

internal static class UpdateShortcutValidator
{
    public static Dictionary<string, string[]> Validate(UpdateShortcutRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        if (request is null || (request.CustomLabel is null && request.Enabled is null))
        {
            errors["body"] = ["Informe customLabel ou enabled."];
            return errors;
        }

        if (request.CustomLabel is { } label)
        {
            if (label.Trim().Length > Shortcut.CustomLabelMax)
            {
                errors["customLabel"] = [$"O nome deve ter no máximo {Shortcut.CustomLabelMax} caracteres."];
            }
            else if (label.Any(c => c <= '\u001f' || (c >= '\u007f' && c <= '\u009f')))
            {
                errors["customLabel"] = ["O nome não pode ter caracteres de controle."];
            }
        }

        return errors;
    }
}

internal sealed class UpdateShortcutHandler(TvDbContext db, ITvShortcutReader reader, ITvStreamPublisher stream, TimeProvider time)
{
    /// <summary>Devolve o atalho atualizado, ou nulo quando ele não existe.</summary>
    public async Task<TvShortcut?> HandleAsync(UpdateShortcutCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var shortcut = await db.Shortcuts.SingleOrDefaultAsync(s => s.Id == command.ShortcutId, cancellationToken);
        if (shortcut is null)
        {
            return null;
        }

        var now = time.GetUtcNow();
        if (command.CustomLabel is not null)
        {
            shortcut.SetCustomLabel(command.CustomLabel, now);
        }

        if (command.Enabled is { } enabled)
        {
            shortcut.SetEnabled(enabled, now);
        }

        await db.SaveChangesAsync(cancellationToken);
        stream.PublishShortcuts(await reader.ListAsync(cancellationToken));
        return TvShortcut.From(shortcut);
    }
}

internal static class UpdateShortcutEndpoint
{
    public static void MapUpdateShortcut(this IEndpointRouteBuilder group) =>
        group.MapPatch("/shortcuts/{id:guid}", HandleAsync).RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<TvShortcut>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound);

    private static async Task<IResult> HandleAsync(
        Guid id, UpdateShortcutRequest? request, UpdateShortcutHandler handler, CancellationToken cancellationToken)
    {
        var errors = UpdateShortcutValidator.Validate(request);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var updated = await handler.HandleAsync(new UpdateShortcutCommand(id, request!.CustomLabel, request.Enabled), cancellationToken);
        return updated is null ? TypedResults.NotFound() : TypedResults.Ok(updated);
    }
}
