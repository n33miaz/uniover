using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.CalendarEntries;

/// <summary>Corpo do <c>PUT</c> de um dia: ausência planejada e/ou nota curta; <c>Deleted</c> grava a lápide.</summary>
internal sealed record CalendarEntryRequest(bool Absent, string? Note, DateTimeOffset? ClientUpdatedAt, bool Deleted);

/// <summary>
/// O dia como o aparelho o recebe (leitura incremental e resposta da escrita). Na lápide a ausência vem falsa e a nota
/// vazia; <c>UpdatedAt</c> ordena o cursor e <c>DayKey</c> (AAAA-MM-DD) é a chave natural que o aparelho usa.
/// </summary>
internal sealed record CalendarEntryResponse(
    Guid Id,
    string DayKey,
    bool Absent,
    string? Note,
    DateTimeOffset UpdatedAt,
    DateTimeOffset ClientUpdatedAt,
    bool Deleted)
{
    public static CalendarEntryResponse From(CalendarEntry row)
    {
        ArgumentNullException.ThrowIfNull(row);

        return new CalendarEntryResponse(
            row.Id,
            row.Day.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
            !row.IsDeleted && row.Absent,
            row.IsDeleted ? null : row.Note,
            row.UpdatedAt,
            row.ClientUpdatedAt,
            row.IsDeleted);
    }
}

internal sealed record CalendarEntriesResponse(IReadOnlyList<CalendarEntryResponse> Items, string? NextCursor);

internal enum CalendarEntryOutcome
{
    Ok,
    ClockAhead,
}

internal sealed record CalendarEntryResult(CalendarEntryOutcome Outcome, CalendarEntryResponse? Entry = null);

/// <summary>Erros da agenda como ProblemDetails, com os <c>type</c> estáveis que o aparelho reconhece.</summary>
internal static class CalendarEntryProblems
{
    public const string ClientClockAheadType = "client-clock-ahead";

    public static IResult Unauthenticated() =>
        Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Sessão inválida ou expirada.");

    public static IResult ClientClockAhead() =>
        Results.Problem(
            statusCode: StatusCodes.Status422UnprocessableEntity,
            title: "O relógio do aparelho está mais de 24 horas à frente do servidor.",
            type: ProblemDetailsExtensions.TypeBase + ClientClockAheadType);
}

/// <summary>Validação de corpo e rota; devolve os erros por campo, vazios quando está tudo certo.</summary>
internal static class CalendarEntryValidator
{
    public const int MaxNoteLength = 280;

    // Um intervalo largo o bastante para qualquer treino real e curto o bastante para barrar erro de digitação.
    private static readonly DateOnly Earliest = new(2000, 1, 1);
    private static readonly DateOnly Latest = new(2100, 12, 31);

    public static Dictionary<string, string[]> Validate(string dayKey, CalendarEntryRequest? request, out DateOnly day)
    {
        var errors = new Dictionary<string, string[]>();
        if (!DateOnly.TryParseExact(dayKey, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out day)
            || day < Earliest
            || day > Latest)
        {
            errors["dayKey"] = ["Informe uma data válida (AAAA-MM-DD)."];
        }

        if (request is null)
        {
            errors["body"] = ["Informe o corpo da requisição."];
            return errors;
        }

        if (request.ClientUpdatedAt is not { } clientAt || clientAt == default)
        {
            errors["clientUpdatedAt"] = ["Informe o instante da escrita no aparelho."];
        }

        if (request.Note is { } note && note.Trim().Length > MaxNoteLength)
        {
            errors["note"] = [$"A nota deve ter até {MaxNoteLength} caracteres."];
        }

        // Um dia vivo precisa ter ausência ou nota; sem nenhum dos dois, quem quer limpar manda a lápide.
        if (!request.Deleted && !request.Absent && string.IsNullOrWhiteSpace(request.Note))
        {
            errors["body"] = ["Marque a ausência, escreva uma nota ou remova o dia."];
        }

        return errors;
    }
}

internal sealed class CalendarEntriesHandler(TrainingDbContext db, TimeProvider time)
{
    // Cada rodada perdida significa que outra escrita ganhou; com conteúdo igual a segunda rodada já encerra sem gravar.
    private const int MaxAttempts = 8;

    /// <summary>
    /// Grava, troca ou remove (por lápide) o dia do usuário, achando-o pela chave natural (usuário + dia). Última escrita
    /// vence pelo relógio do aparelho; escrita mais velha devolve o que já está guardado.
    /// </summary>
    public async Task<CalendarEntryResult> UpsertAsync(Guid userId, DateOnly day, CalendarEntryRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var now = TimeStamps.ToStorage(time.GetUtcNow());
        var client = TimeStamps.ToStorage(request.ClientUpdatedAt!.Value);
        if (LastWriterWins.IsClockAhead(client, now))
        {
            return new CalendarEntryResult(CalendarEntryOutcome.ClockAhead);
        }

        var note = string.IsNullOrWhiteSpace(request.Note) ? null : request.Note.Trim();
        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var row = await db.Set<CalendarEntry>()
                .SingleOrDefaultAsync(x => x.UserId == userId && x.Day == day, cancellationToken);
            if (row is null)
            {
                row = new CalendarEntry { Id = Guid.CreateVersion7(), UserId = userId, Day = day, CreatedAt = now };
                db.Set<CalendarEntry>().Add(row);
            }
            else if (!LastWriterWins.ShouldApply(client, row.ClientUpdatedAt))
            {
                return new CalendarEntryResult(CalendarEntryOutcome.Ok, CalendarEntryResponse.From(row));
            }

            row.Absent = !request.Deleted && request.Absent;
            row.Note = request.Deleted ? null : note;
            row.ClientUpdatedAt = client;
            row.UpdatedAt = now;
            row.DeletedAt = request.Deleted ? now : null;

            try
            {
                await db.SaveChangesAsync(cancellationToken);
                return new CalendarEntryResult(CalendarEntryOutcome.Ok, CalendarEntryResponse.From(row));
            }
            catch (DbUpdateConcurrencyException)
            {
                db.ChangeTracker.Clear();
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                // Outra escrita criou o mesmo dia no mesmo instante: relê pela chave natural e decide de novo.
                db.ChangeTracker.Clear();
            }
        }

        throw new InvalidOperationException("Não foi possível gravar o dia: muitas escritas concorrentes no mesmo dia.");
    }

    /// <summary>
    /// Os dias do usuário em páginas ordenadas por (instante, id), lápides incluídas. Toda consulta filtra pelo usuário da
    /// sessão: a agenda de outra pessoa nunca aparece.
    /// </summary>
    public async Task<CalendarEntriesResponse> PullAsync(Guid userId, PullCursor? after, int limit, CancellationToken cancellationToken)
    {
        var rows = db.Set<CalendarEntry>().AsNoTracking().Where(x => x.UserId == userId);
        if (after is { } cursor)
        {
            var stamp = cursor.UpdatedAt;
            var id = cursor.Id;
            rows = rows.Where(x => x.UpdatedAt > stamp || (x.UpdatedAt == stamp && x.Id.CompareTo(id) > 0));
        }

        var page = await rows.OrderBy(x => x.UpdatedAt).ThenBy(x => x.Id).Take(limit).ToListAsync(cancellationToken);
        var next = page.Count > 0 ? new PullCursor(page[^1].UpdatedAt, page[^1].Id).Encode() : after?.Encode();
        return new CalendarEntriesResponse(page.Select(CalendarEntryResponse.From).ToList(), next);
    }
}

internal static class CalendarEntriesEndpoints
{
    public static void MapCalendarEntriesEndpoints(this IEndpointRouteBuilder group)
    {
        group.MapPut("/calendar-entries/{dayKey}", PutAsync)
            .RequireAuthorization(TrainingAuth.Module)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<CalendarEntryResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .RequireIdempotency<TrainingDbContext>();

        group.MapGet("/calendar-entries", PullAsync)
            .RequireAuthorization(TrainingAuth.Module)
            .Produces<CalendarEntriesResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);
    }

    private static async Task<IResult> PutAsync(
        string dayKey,
        CalendarEntryRequest? request,
        ICurrentUser current,
        CalendarEntriesHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return CalendarEntryProblems.Unauthenticated();
        }

        var errors = CalendarEntryValidator.Validate(dayKey, request, out var day);
        if (errors.Count > 0 || request is null)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var result = await handler.UpsertAsync(userId, day, request, cancellationToken);
        return result.Outcome == CalendarEntryOutcome.Ok
            ? TypedResults.Ok(result.Entry)
            : CalendarEntryProblems.ClientClockAhead();
    }

    private static async Task<IResult> PullAsync(
        ICurrentUser current,
        CalendarEntriesHandler handler,
        string? after,
        int? limit,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return CalendarEntryProblems.Unauthenticated();
        }

        PullCursor? cursor = null;
        var errors = new Dictionary<string, string[]>();
        if (!string.IsNullOrEmpty(after))
        {
            if (PullCursor.TryDecode(after, out var decoded))
            {
                cursor = decoded;
            }
            else
            {
                errors["after"] = ["O cursor não é válido."];
            }
        }

        var pageSize = limit ?? PullCursor.DefaultLimit;
        if (pageSize is < 1 or > PullCursor.MaxLimit)
        {
            errors["limit"] = [$"O limite deve ficar entre 1 e {PullCursor.MaxLimit}."];
        }

        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        return TypedResults.Ok(await handler.PullAsync(userId, cursor, pageSize, cancellationToken));
    }
}
