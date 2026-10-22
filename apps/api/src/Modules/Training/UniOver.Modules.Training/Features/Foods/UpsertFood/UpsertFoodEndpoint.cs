using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Domain.Foods;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Foods.UpsertFood;

internal sealed record UpsertFoodRequest(string? Name, string? Brand, string? Barcode, decimal KcalPer100g,
    decimal ProteinPer100g, decimal CarbsPer100g, decimal FatPer100g, decimal? DefaultPortionGrams,
    DateTimeOffset? ClientUpdatedAt, bool Deleted);

internal enum UpsertFoodOutcome { Ok, NotFound, Forbidden, ClockAhead }
internal sealed record UpsertFoodResult(UpsertFoodOutcome Outcome, FoodResponse? Food = null);

internal sealed class UpsertFoodHandler(TrainingDbContext db, TimeProvider time)
{
    public async Task<UpsertFoodResult> HandleAsync(Guid id, Guid userId, UpsertFoodRequest request, CancellationToken ct)
    {
        var now = UniOver.Modules.Training.Domain.TimeStamps.ToStorage(time.GetUtcNow());
        if (UniOver.Modules.Training.Domain.LastWriterWins.IsClockAhead(request.ClientUpdatedAt!.Value, now)) return new(UpsertFoodOutcome.ClockAhead);
        for (var attempt = 0; attempt < 8; attempt++)
        {
            var row = await db.Set<Food>().SingleOrDefaultAsync(f => f.Id == id, ct);
            if (row is not null && (row.Source != FoodSources.Own || row.OwnerUserId != userId)) return new(UpsertFoodOutcome.Forbidden);
            if (row is not null && !UniOver.Modules.Training.Domain.LastWriterWins.ShouldApply(request.ClientUpdatedAt.Value, row.ClientUpdatedAt)) return new(UpsertFoodOutcome.Ok, FoodResponse.From(row));
            row ??= new Food { Id = id, Source = FoodSources.Own, OwnerUserId = userId, CreatedAt = now };
            row.Name = request.Deleted ? row.Name : request.Name!.Trim();
            row.Brand = request.Deleted ? row.Brand : request.Brand?.Trim();
            row.Barcode = request.Deleted ? row.Barcode : request.Barcode;
            row.KcalPer100g = request.Deleted ? row.KcalPer100g : request.KcalPer100g;
            row.ProteinPer100g = request.Deleted ? row.ProteinPer100g : request.ProteinPer100g;
            row.CarbsPer100g = request.Deleted ? row.CarbsPer100g : request.CarbsPer100g;
            row.FatPer100g = request.Deleted ? row.FatPer100g : request.FatPer100g;
            row.DefaultPortionGrams = request.Deleted ? row.DefaultPortionGrams : request.DefaultPortionGrams;
            row.DeletedAt = request.Deleted ? now : null;
            row.ClientUpdatedAt = request.ClientUpdatedAt.Value;
            row.UpdatedAt = now;
            if (db.Entry(row).State == EntityState.Detached) db.Set<Food>().Add(row);
            try { await db.SaveChangesAsync(ct); return new(UpsertFoodOutcome.Ok, FoodResponse.From(row)); }
            catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: Npgsql.PostgresErrorCodes.UniqueViolation }) { db.ChangeTracker.Clear(); }
            catch (DbUpdateConcurrencyException) { db.ChangeTracker.Clear(); }
        }
        throw new InvalidOperationException("Muitas escritas concorrentes no alimento.");
    }
}

internal static class UpsertFoodEndpoint
{
    public static void MapUpsertFood(this IEndpointRouteBuilder group) => group.MapPut("/foods/{id:guid}", HandleAsync)
        .RequireAuthorization(TrainingAuth.Module).RequireRateLimiting(RateLimitPolicies.Commands)
        .RequireIdempotency<TrainingDbContext>().Produces<FoodResponse>().ProducesProblem(400).ProducesProblem(401)
        .ProducesProblem(403).ProducesProblem(404).ProducesProblem(422).ProducesProblem(429);

    private static async Task<IResult> HandleAsync(Guid id, UpsertFoodRequest? request, ICurrentUser current,
        UpsertFoodHandler handler, TimeProvider time, CancellationToken ct)
    {
        if (current.UserId is not { } userId) return Results.Problem(statusCode: 401, title: "Sessão inválida ou expirada.");
        var errors = new Dictionary<string, string[]>();
        if (request is null) errors["body"] = ["Informe o alimento."];
        else
        {
            if (!request.Deleted && (string.IsNullOrWhiteSpace(request.Name) || request.Name.Trim().Length > FoodRules.NameMax)) errors["name"] = ["Informe um nome com até 160 caracteres."];
            if (request.Brand?.Length > FoodRules.BrandMax) errors["brand"] = ["A marca aceita até 120 caracteres."];
            if (request.Barcode is { } code && (code.Length is < 8 or > 14 || code.Any(c => !char.IsAsciiDigit(c)))) errors["barcode"] = ["O código deve ter de 8 a 14 dígitos."];
            if (!request.Deleted && (!FoodRules.IsValidMacro(request.KcalPer100g) || !FoodRules.IsValidMacro(request.ProteinPer100g) || !FoodRules.IsValidMacro(request.CarbsPer100g) || !FoodRules.IsValidMacro(request.FatPer100g))) errors["macros"] = ["Os valores por 100 g devem ser não negativos e ter até duas casas decimais."];
            if (!FoodRules.IsValidPortion(request.DefaultPortionGrams)) errors["defaultPortionGrams"] = ["A porção deve ser positiva e ter até duas casas decimais."];
            if (request.ClientUpdatedAt is null) errors["clientUpdatedAt"] = ["Informe quando o aparelho atualizou o registro."];
            else if (Domain.LastWriterWins.IsClockAhead(request.ClientUpdatedAt.Value, time.GetUtcNow())) errors["clientUpdatedAt"] = ["O relógio do aparelho está mais de 24 horas à frente do servidor."];
        }
        if (errors.Count > 0) return ProblemDetailsExtensions.ValidationProblem(errors);
        var result = await handler.HandleAsync(id, userId, request!, ct);
        return result switch
        {
            { Outcome: UpsertFoodOutcome.Forbidden } => Results.Problem(statusCode: 403, title: "Alimento externo ou de outra pessoa não pode ser alterado.", type: ProblemDetailsExtensions.TypeBase + "food-forbidden"),
            { Outcome: UpsertFoodOutcome.ClockAhead } => Results.Problem(statusCode: 422, title: "O relógio do aparelho está mais de 24 horas à frente do servidor.", type: ProblemDetailsExtensions.TypeBase + "client-clock-ahead"),
            { Outcome: UpsertFoodOutcome.Ok, Food: { } food } => Results.Ok(food),
            _ => Results.Problem(statusCode: 404, title: "Alimento não encontrado.", type: ProblemDetailsExtensions.TypeBase + "food-not-found"),
        };
    }
}
