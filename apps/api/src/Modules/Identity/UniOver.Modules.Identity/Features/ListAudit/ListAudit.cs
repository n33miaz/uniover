using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Audit;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;
using UniOver.SharedKernel.Audit;

namespace UniOver.Modules.Identity.Features.ListAudit;

/// <summary>
/// Confere os parâmetros da consulta à trilha. Tudo que vem do cliente é validado aqui e o erro nunca repete o valor
/// recebido; devolve os filtros prontos ou os erros por campo.
/// </summary>
internal static partial class AuditFilterParser
{
    public const int MaxListItems = 20;

    [GeneratedRegex("^[a-z0-9_.-]{1,64}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex CodePattern();

    public static (AuditFilter? Filter, Dictionary<string, string[]> Errors) Parse(
        string? from,
        string? to,
        string? person,
        IReadOnlyCollection<string>? modules,
        IReadOnlyCollection<string>? actions,
        string? outcome,
        IReadOnlyCollection<string> knownModules)
    {
        ArgumentNullException.ThrowIfNull(knownModules);

        var errors = new Dictionary<string, string[]>();
        var fromValue = Instant(from, "from", errors);
        var toValue = Instant(to, "to", errors);
        if (fromValue is { } start && toValue is { } end && start >= end)
        {
            errors["to"] = ["O fim do período deve ser depois do início."];
        }

        Guid? personValue = null;
        if (!string.IsNullOrEmpty(person))
        {
            if (Guid.TryParse(person, out var id))
            {
                personValue = id;
            }
            else
            {
                errors["person"] = ["Informe o id da conta."];
            }
        }

        var moduleList = Codes(modules, "module", errors);
        if (moduleList.Any(m => !knownModules.Contains(m, StringComparer.Ordinal)))
        {
            errors["module"] = ["Módulo desconhecido."];
        }

        var actionList = Codes(actions, "action", errors);

        AuditOutcome? outcomeValue = null;
        if (!string.IsNullOrEmpty(outcome))
        {
            if (AuditOutcomes.TryParse(outcome, out var parsed))
            {
                outcomeValue = parsed;
            }
            else
            {
                errors["outcome"] = [$"Use um destes: {string.Join(", ", AuditOutcomes.All)}."];
            }
        }

        return errors.Count > 0
            ? (null, errors)
            : (new AuditFilter(fromValue, toValue, personValue, moduleList, actionList, outcomeValue), errors);
    }

    /// <summary>Instante ISO 8601; sem deslocamento vale UTC. O erro não ecoa o texto recebido.</summary>
    private static DateTimeOffset? Instant(string? value, string field, Dictionary<string, string[]> errors)
    {
        if (string.IsNullOrEmpty(value))
        {
            return null;
        }

        if (DateTimeOffset.TryParse(
                value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed))
        {
            return parsed;
        }

        errors[field] = ["Informe uma data e hora no formato ISO 8601 (por exemplo, 2026-10-21T13:00:00Z)."];
        return null;
    }

    private static List<string> Codes(IReadOnlyCollection<string>? values, string field, Dictionary<string, string[]> errors)
    {
        var list = new List<string>();
        foreach (var value in values ?? [])
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                continue;
            }

            if (!CodePattern().IsMatch(value) || list.Count >= MaxListItems)
            {
                errors[field] = ["Valor inválido."];
                return [];
            }

            list.Add(value);
        }

        return [.. list.Distinct(StringComparer.Ordinal)];
    }

    /// <summary>Limite de uma página: padrão 50, máximo 200.</summary>
    public static bool TryLimit(int? limit, out int value, Dictionary<string, string[]> errors)
    {
        ArgumentNullException.ThrowIfNull(errors);

        value = limit ?? AuditReader.DefaultLimit;
        if (value is >= 1 and <= AuditReader.MaxLimit)
        {
            return true;
        }

        errors["limit"] = [$"O limite deve ficar entre 1 e {AuditReader.MaxLimit}."];
        return false;
    }
}

internal static class AuditEndpoints
{
    public static void MapListAudit(this IEndpointRouteBuilder group)
    {
        // Só o administrador lê a trilha (IP e aparelho de terceiros); ler não pede passkey. O convidado, mesmo com todas
        // as permissões de módulo, recebe 403: a política é a do dono e nenhuma permissão do catálogo a concede.
        group.MapGet("/audit", ListAsync)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<AuditPage>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

        group.MapGet("/audit/sources", Sources)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<AuditSourcesResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

        group.MapGet("/audit/export", ExportAsync)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces(StatusCodes.Status200OK, contentType: "text/csv")
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);
    }

    /// <param name="module">Repetível: <c>?module=tv&amp;module=devices</c>.</param>
    /// <param name="action">Repetível: um ou mais códigos de ação.</param>
    /// <param name="person">Id da conta: o que ela fez e o que foi feito sobre ela.</param>
    /// <param name="cursor"><c>nextCursor</c> da página anterior.</param>
    private static async Task<IResult> ListAsync(
        AuditReader reader,
        CancellationToken cancellationToken,
        [FromQuery] string? from = null,
        [FromQuery] string? to = null,
        [FromQuery] string? person = null,
        [FromQuery] string[]? module = null,
        [FromQuery] string[]? action = null,
        [FromQuery] string? outcome = null,
        [FromQuery] string? cursor = null,
        [FromQuery] int? limit = null)
    {
        var (filter, errors) = AuditFilterParser.Parse(from, to, person, module, action, outcome, reader.KnownModules);
        AuditCursor? after = null;

        // Cursor malformado, ou de uma fonte que não existe, é erro do cliente (400), nunca 500.
        if (!string.IsNullOrEmpty(cursor)
            && !(AuditCursor.TryDecode(cursor, out after) && reader.KnownModules.Contains(after!.Module, StringComparer.Ordinal)))
        {
            errors["cursor"] = ["Cursor inválido."];
        }

        if (!AuditFilterParser.TryLimit(limit, out var take, errors) || filter is null || errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        return TypedResults.Ok(await reader.ReadPageAsync(filter, take, after, cancellationToken));
    }

    private static Ok<AuditSourcesResponse> Sources(AuditReader reader) => TypedResults.Ok(reader.DescribeSources());

    /// <summary>
    /// Exporta a consulta atual (mesmos filtros, sem página) em CSV, limitada a <see cref="AuditReader.ExportMaxRows"/>
    /// linhas; passando do teto o arquivo traz as mais novas e o cabeçalho <c>X-Audit-Truncated</c> avisa. A exportação
    /// leva dado pessoal de terceiros para fora do sistema, então ela mesma fica registrada na trilha.
    /// </summary>
    private static async Task<IResult> ExportAsync(
        HttpContext http,
        ICurrentUser current,
        AuditReader reader,
        IdentityDbContext db,
        LoginAuditWriter audit,
        TimeProvider time,
        CancellationToken cancellationToken,
        [FromQuery] string? from = null,
        [FromQuery] string? to = null,
        [FromQuery] string? person = null,
        [FromQuery] string[]? module = null,
        [FromQuery] string[]? action = null,
        [FromQuery] string? outcome = null)
    {
        if (current.UserId is not { } userId)
        {
            return IdentityProblems.Unauthenticated();
        }

        var (filter, errors) = AuditFilterParser.Parse(from, to, person, module, action, outcome, reader.KnownModules);
        if (filter is null || errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var page = await reader.ReadPageAsync(filter, AuditReader.ExportMaxRows, null, cancellationToken);

        // O registro da exportação vai DEPOIS da consulta: a própria linha nova não entra no arquivo que ela descreve.
        audit.Add(
            userId,
            AuditEvents.AuditExported,
            ClientInfo.From(http),
            string.Create(CultureInfo.InvariantCulture, $"rows={page.Items.Count}"));
        await db.SaveChangesAsync(cancellationToken);

        if (page.NextCursor is not null)
        {
            http.Response.Headers["X-Audit-Truncated"] = "true";
        }

        var name = string.Create(CultureInfo.InvariantCulture, $"auditoria-{time.GetUtcNow():yyyyMMdd-HHmm}.csv");
        return Results.File(AuditCsv.Write(page.Items), "text/csv; charset=utf-8", name);
    }
}
