using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.ReorderShortcuts;

/// <param name="Ids">A ordem desejada de TODOS os atalhos (instalados ou não, no controle ou não), cada id uma vez.</param>
internal sealed record ReorderShortcutsRequest(IReadOnlyList<Guid>? Ids);

internal sealed record ReorderShortcutsCommand(TvCommandOrigin Origin, IReadOnlyList<Guid> Ids);

internal static class ReorderShortcutsValidator
{
    public static Dictionary<string, string[]> Validate(ReorderShortcutsRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        if (request?.Ids is not { } ids)
        {
            errors["ids"] = ["Informe a lista de atalhos (ids) na ordem desejada."];
        }
        else if (ids.Count > ShortcutCatalog.MaxReorderIds)
        {
            errors["ids"] = [$"A lista pode ter no máximo {ShortcutCatalog.MaxReorderIds} atalhos."];
        }
        else if (ids.Distinct().Count() != ids.Count)
        {
            errors["ids"] = ["Cada atalho pode aparecer uma vez só."];
        }

        return errors;
    }
}

internal sealed partial class ReorderShortcutsHandler(
    TvDbContext db,
    ITvShortcutReader reader,
    ITvStreamPublisher stream,
    ITvCommandAudit audit,
    TimeProvider time,
    ILogger<ReorderShortcutsHandler> logger)
{
    /// <summary>
    /// Grava a nova ordem e devolve a lista como a tela a recebe, ou nulo quando <c>Ids</c> não é uma permutação exata
    /// dos atalhos que existem (uma tela com a lista velha, por exemplo): nada é gravado nesse caso. As posições mudam
    /// todas num só <c>SaveChanges</c>, que é uma transação; o índice de <c>position</c> não é único, então a troca
    /// não tropeça em si mesma no meio.
    /// </summary>
    public async Task<IReadOnlyList<TvShortcut>?> HandleAsync(ReorderShortcutsCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var existing = await db.Shortcuts.ToListAsync(cancellationToken);
        var now = time.GetUtcNow();
        if (!ShortcutCatalog.TryReorder(existing, command.Ids, now, out var changed))
        {
            return null;
        }

        if (changed)
        {
            await db.SaveChangesAsync(cancellationToken);
        }

        var list = await reader.ListAsync(cancellationToken);

        // Sem mudança nada precisa chegar às outras telas; com ela, o mesmo fluxo que o PATCH de atalho usa.
        if (changed)
        {
            stream.PublishShortcuts(list);
            await RecordAsync(command, now);
        }

        return list;
    }

    // A trilha guarda quem mudou a ordem, mas falhar ao gravá-la nunca desfaz a ordem já gravada: vira log de erro.
    private async Task RecordAsync(ReorderShortcutsCommand command, DateTimeOffset now)
    {
        try
        {
            var entry = CommandAuditEntry.Create(
                command.Origin.UserId, null, TvCommandNames.ShortcutsReorder, $"count={command.Ids.Count}",
                ok: true, errorCode: null, latencyMs: null, command.Origin.Client, now);
            await audit.RecordAsync(entry, CancellationToken.None);
        }
#pragma warning disable CA1031 // A auditoria não pode desfazer a ordem: o erro vai para o log.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogAuditFailed(ex);
        }
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Falha ao gravar a auditoria da reordenação dos atalhos.")]
    private partial void LogAuditFailed(Exception exception);
}

internal static class ReorderShortcutsEndpoint
{
    public static void MapReorderShortcuts(this IEndpointRouteBuilder group) =>
        group.MapPut("/shortcuts/order", HandleAsync).RequireAuthorization(UniOverAuth.OwnerPolicy)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<IReadOnlyList<TvShortcut>>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        ReorderShortcutsRequest? request,
        ICurrentUser current,
        HttpContext http,
        ReorderShortcutsHandler handler,
        CancellationToken cancellationToken)
    {
        var errors = ReorderShortcutsValidator.Validate(request);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        var list = await handler.HandleAsync(new ReorderShortcutsCommand(origin, request!.Ids!), cancellationToken);
        return list is null
            ? ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["ids"] = ["A lista precisa ter todos os atalhos, cada um uma vez. Atualize a lista de apps e tente de novo."],
            })
            : TypedResults.Ok(list);
    }
}
