using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Routines;
using UniOver.Modules.Training.Features.Body.PullBodyEntries;
using UniOver.Modules.Training.Features.Routines.ListRoutineTemplates;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Routines.Programs;

/// <summary>Corpo do <c>PUT /program</c>: o programa escolhido e o instante da escolha no aparelho.</summary>
internal sealed record SelectTrainingProgramRequest(string? ProgramId, DateTimeOffset? ClientUpdatedAt);

/// <summary>O programa ativo da conta. Não há id nem lápide: a chave é a própria pessoa.</summary>
internal sealed record TrainingProgramResponse(string ProgramId, DateTimeOffset UpdatedAt, DateTimeOffset ClientUpdatedAt)
{
    public static TrainingProgramResponse From(TrainingProgram row) => new(row.ProgramId, row.UpdatedAt, row.ClientUpdatedAt);
}

/// <summary>O mesmo envelope de cursor das outras leituras, com no máximo um item (um programa ativo por pessoa).</summary>
internal sealed record PullTrainingProgramResponse(IReadOnlyList<TrainingProgramResponse> Items, string? NextCursor);

/// <summary>
/// O programa semanal ativo da conta, como registro próprio e sincronizado. As fichas do programa são criadas no
/// aparelho (com o programa e os dias da semana) e viajam pela fila das rotinas; aqui fica só a ESCOLHA, que o outro
/// aparelho lê no pull. Idempotente: o reenvio não muda nada, e as primeiras escolhas simultâneas terminam numa linha só
/// (a chave primária decide; quem perde relê e aplica o último a escrever).
/// </summary>
internal sealed class TrainingProgramHandler(TrainingDbContext db, RoutineTemplateSource templates, TimeProvider time)
{
    /// <summary>O histórico rejeitado nunca vira programa: só se cria por "Usar modelo", inativo.</summary>
    public const string HistoricalTemplateId = "historical-ab";

    private const int MaxAttempts = 8;

    public bool IsProgram(string? programId) =>
        !string.IsNullOrWhiteSpace(programId)
        && programId != HistoricalTemplateId
        && templates.Document.Items.Any(x => x.Id == programId);

    public async Task<(bool ClockAhead, TrainingProgramResponse? Program)> UpsertAsync(
        Guid userId, string programId, DateTimeOffset clientUpdatedAt, CancellationToken cancellationToken)
    {
        var now = TimeStamps.ToStorage(time.GetUtcNow());
        var client = TimeStamps.ToStorage(clientUpdatedAt);
        if (LastWriterWins.IsClockAhead(client, now))
        {
            return (true, null);
        }

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var row = await db.Programs.SingleOrDefaultAsync(p => p.UserId == userId, cancellationToken);
            if (row is null)
            {
                row = new TrainingProgram { UserId = userId, ProgramId = programId, UpdatedAt = now, ClientUpdatedAt = client };
                db.Programs.Add(row);
            }
            else if (!LastWriterWins.ShouldApply(client, row.ClientUpdatedAt) || (row.ProgramId == programId && row.ClientUpdatedAt == client))
            {
                // Escolha mais velha (ou reenvio idêntico): vale o que já está guardado.
                return (false, TrainingProgramResponse.From(row));
            }
            else
            {
                row.ProgramId = programId;
                row.ClientUpdatedAt = client;
                row.UpdatedAt = now;
            }

            try
            {
                await db.SaveChangesAsync(cancellationToken);
                return (false, TrainingProgramResponse.From(row));
            }
            catch (DbUpdateConcurrencyException)
            {
                db.ChangeTracker.Clear();
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                // Outra escolha criou a linha no mesmo instante: relê pela chave natural e decide de novo.
                db.ChangeTracker.Clear();
            }
        }

        throw new InvalidOperationException("Não foi possível gravar o programa: muitas escritas concorrentes.");
    }

    /// <summary>O programa da conta, se mudou depois do cursor (cursor = instante e id do usuário, que é a chave).</summary>
    public async Task<PullTrainingProgramResponse> PullAsync(Guid userId, PullCursor? after, CancellationToken cancellationToken)
    {
        var rows = db.Programs.AsNoTracking().Where(p => p.UserId == userId);
        if (after is { } cursor)
        {
            var stamp = cursor.UpdatedAt;
            var id = cursor.Id;
            rows = rows.Where(p => p.UpdatedAt > stamp || (p.UpdatedAt == stamp && p.UserId.CompareTo(id) > 0));
        }

        var row = await rows.SingleOrDefaultAsync(cancellationToken);
        return row is null
            ? new PullTrainingProgramResponse([], after?.Encode())
            : new PullTrainingProgramResponse([TrainingProgramResponse.From(row)], new PullCursor(row.UpdatedAt, row.UserId).Encode());
    }
}

internal static class SelectTrainingProgramEndpoint
{
    public static void MapTrainingProgram(this IEndpointRouteBuilder group) =>
        group.MapPut("/program", PutAsync).RequireAuthorization(TrainingAuth.Module)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<TrainingProgramResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .RequireIdempotency<TrainingDbContext>();

    public static void MapGetTrainingProgram(this IEndpointRouteBuilder group) =>
        group.MapGet("/program", GetAsync).RequireAuthorization(TrainingAuth.Module)
            .Produces<PullTrainingProgramResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static async Task<IResult> GetAsync(
        ICurrentUser current, TrainingProgramHandler handler, string? after, int? limit, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId) return RoutineProblems.Unauthenticated();

        // O puxador genérico do aparelho manda `limit` em toda leitura; aqui ele só é conferido (há no máximo um programa).
        var errors = PullBodyValidator.Validate(after, limit, out var cursor, out _);
        if (errors.Count > 0) return ProblemDetailsExtensions.ValidationProblem(errors);

        return TypedResults.Ok(await handler.PullAsync(userId, cursor, cancellationToken));
    }

    private static async Task<IResult> PutAsync(
        SelectTrainingProgramRequest? request, ICurrentUser current, TrainingProgramHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId) return RoutineProblems.Unauthenticated();

        var programId = request?.ProgramId?.Trim();
        var errors = new Dictionary<string, string[]>();
        if (!handler.IsProgram(programId)) errors["programId"] = ["Escolha um programa válido."];
        if (request?.ClientUpdatedAt is null || request.ClientUpdatedAt == default(DateTimeOffset))
            errors["clientUpdatedAt"] = ["Informe o instante da escolha no aparelho."];
        if (errors.Count > 0) return ProblemDetailsExtensions.ValidationProblem(errors);

        var (clockAhead, program) = await handler.UpsertAsync(userId, programId!, request!.ClientUpdatedAt!.Value, cancellationToken);
        return clockAhead ? RoutineProblems.ClientClockAhead() : TypedResults.Ok(program);
    }
}
