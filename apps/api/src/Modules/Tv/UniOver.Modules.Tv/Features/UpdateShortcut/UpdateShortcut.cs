using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.UpdateShortcut;

/// <param name="CustomLabel">Nome próprio do atalho; texto vazio apaga e volta a "Atalho n". Ausente = não muda.</param>
/// <param name="Enabled">Mostrar ou esconder o atalho. Ausente = não muda.</param>
internal sealed record UpdateShortcutRequest(string? CustomLabel, bool? Enabled);

internal sealed record UpdateShortcutCommand(Guid ShortcutId, string? CustomLabel, bool? Enabled, TvCommandOrigin Origin);

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

internal sealed partial class UpdateShortcutHandler(
    TvDbContext db,
    ITvShortcutReader reader,
    ITvStreamPublisher stream,
    ITvCommandAudit audit,
    TimeProvider time,
    ILogger<UpdateShortcutHandler> logger)
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
        await RecordAsync(command, now);
        return TvShortcut.From(shortcut);
    }

    /// <summary>
    /// Só os códigos dos campos mudados (<c>label</c>, <c>enabled=true</c>): o nome novo é texto livre e a trilha não
    /// precisa dele. A trilha guarda quem mexeu, mas falhar ao gravá-la nunca desfaz a mudança já feita: vira log de erro.
    /// </summary>
    private async Task RecordAsync(UpdateShortcutCommand command, DateTimeOffset now)
    {
        try
        {
            var fields = new List<string>(2);
            if (command.CustomLabel is not null)
            {
                fields.Add("label");
            }

            if (command.Enabled is { } enabled)
            {
                fields.Add(enabled ? "enabled=true" : "enabled=false");
            }

            var entry = CommandAuditEntry.Create(
                command.Origin.UserId, null, TvCommandNames.ShortcutUpdate, string.Join(',', fields),
                ok: true, errorCode: null, latencyMs: null, command.Origin.Client, now);
            await audit.RecordAsync(entry, CancellationToken.None);
        }
#pragma warning disable CA1031 // A auditoria não pode desfazer a mudança: o erro vai para o log.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogAuditFailed(ex);
        }
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Falha ao gravar a auditoria da mudança de atalho.")]
    private partial void LogAuditFailed(Exception exception);
}

internal static class UpdateShortcutEndpoint
{
    public static void MapUpdateShortcut(this IEndpointRouteBuilder group) =>
        group.MapPatch("/shortcuts/{id:guid}", HandleAsync).RequireAuthorization(TvAuth.EditShortcuts)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<TvShortcut>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound);

    private static async Task<IResult> HandleAsync(
        Guid id,
        UpdateShortcutRequest? request,
        ICurrentUser current,
        HttpContext http,
        UpdateShortcutHandler handler,
        CancellationToken cancellationToken)
    {
        var errors = UpdateShortcutValidator.Validate(request);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        var updated = await handler.HandleAsync(
            new UpdateShortcutCommand(id, request!.CustomLabel, request.Enabled, origin), cancellationToken);
        return updated is null ? TypedResults.NotFound() : TypedResults.Ok(updated);
    }
}
