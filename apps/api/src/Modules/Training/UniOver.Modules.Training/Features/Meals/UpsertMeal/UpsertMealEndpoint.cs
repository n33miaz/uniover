using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Domain.Foods;
using UniOver.Modules.Training.Features.Foods;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Meals.UpsertMeal;

internal sealed record UpsertMealRequest(Guid? FoodId, DateOnly? EatenOn, DateTimeOffset? EatenAt, string? MealType,
    string? Name, decimal QuantityG, decimal Kcal, decimal ProteinG, decimal CarbG, decimal FatG, string? Note,
    DateTimeOffset? ClientUpdatedAt, bool Deleted);

internal sealed class UpsertMealHandler(TrainingDbContext db, TimeProvider time)
{
    public async Task<MealResponse?> HandleAsync(Guid id, Guid userId, UpsertMealRequest request, CancellationToken ct)
    {
        if (request.FoodId is { } foodId)
        {
            var food = await db.Set<Food>().AsNoTracking().SingleOrDefaultAsync(f => f.Id == foodId && (f.OwnerUserId == null || f.OwnerUserId == userId), ct);
            if (food is null) return null;
        }
        var now = Domain.TimeStamps.ToStorage(time.GetUtcNow());
        if (Domain.LastWriterWins.IsClockAhead(request.ClientUpdatedAt!.Value, now)) return null;
        for (var attempt = 0; attempt < 8; attempt++)
        {
            var row = await db.Set<MealEntry>().SingleOrDefaultAsync(e => e.Id == id, ct);
            if (row is not null && row.UserId != userId) return null;
            if (row is not null && !Domain.LastWriterWins.ShouldApply(request.ClientUpdatedAt.Value, row.ClientUpdatedAt)) return MealResponse.From(row);
            row ??= new MealEntry { Id = id, UserId = userId, CreatedAt = now };
            if (!request.Deleted)
            {
                row.FoodId = request.FoodId;
                row.EatenOn = request.EatenOn!.Value;
                row.EatenAt = request.EatenAt;
                row.MealType = request.MealType!;
                row.FoodName = request.Name!.Trim();
                row.Grams = request.QuantityG;
                row.Kcal = request.Kcal;
                row.Protein = request.ProteinG;
                row.Carbs = request.CarbG;
                row.Fat = request.FatG;
                row.Note = string.IsNullOrWhiteSpace(request.Note) ? null : request.Note.Trim();
            }
            row.DeletedAt = request.Deleted ? now : null;
            row.ClientUpdatedAt = request.ClientUpdatedAt.Value;
            row.UpdatedAt = now;
            if (db.Entry(row).State == EntityState.Detached) db.Set<MealEntry>().Add(row);
            try { await db.SaveChangesAsync(ct); return MealResponse.From(row); }
            catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: Npgsql.PostgresErrorCodes.UniqueViolation }) { db.ChangeTracker.Clear(); }
            catch (DbUpdateConcurrencyException) { db.ChangeTracker.Clear(); }
        }
        throw new InvalidOperationException("Muitas escritas concorrentes no registro da refeição.");
    }
}

internal static class UpsertMealEndpoint
{
    public static void MapUpsertMeal(this IEndpointRouteBuilder group) => group.MapPut("/meals/{id:guid}", HandleAsync)
        .RequireAuthorization(TrainingAuth.Module).RequireRateLimiting(RateLimitPolicies.Commands).RequireIdempotency<TrainingDbContext>()
        .Produces<MealResponse>().ProducesProblem(400).ProducesProblem(401).ProducesProblem(404).ProducesProblem(422).ProducesProblem(429);

    private static async Task<IResult> HandleAsync(Guid id, UpsertMealRequest? request, ICurrentUser current,
        UpsertMealHandler handler, TimeProvider time, CancellationToken ct)
    {
        if (current.UserId is not { } userId) return Results.Problem(statusCode: 401, title: "Sessão inválida ou expirada.");
        var errors = new Dictionary<string, string[]>();
        if (request is null) errors["body"] = ["Informe a refeição."];
        else
        {
            if (!request.Deleted && request.EatenOn is null) errors["eatenOn"] = ["Informe a data local da refeição."];
            if (!request.Deleted && !MealTypes.IsValid(request.MealType)) errors["mealType"] = ["Tipo de refeição inválido."];
            if (!request.Deleted && (string.IsNullOrWhiteSpace(request.Name) || request.Name.Trim().Length > FoodRules.NameMax)) errors["name"] = ["Informe um nome com até 160 caracteres."];
            if (!request.Deleted && (!FoodRules.IsValidPortion(request.QuantityG) || request.QuantityG <= 0)) errors["quantityG"] = ["A quantidade deve ser positiva e ter até duas casas decimais."];
            if (!request.Deleted && (!FoodRules.IsValidMacro(request.Kcal) || !FoodRules.IsValidMacro(request.ProteinG) || !FoodRules.IsValidMacro(request.CarbG) || !FoodRules.IsValidMacro(request.FatG))) errors["macros"] = ["Os valores congelados da refeição devem ser não negativos e ter até duas casas decimais."];
            if (request.Note?.Length > FoodRules.NoteMax) errors["note"] = ["A anotação aceita até 300 caracteres."];
            if (request.ClientUpdatedAt is null) errors["clientUpdatedAt"] = ["Informe quando o aparelho atualizou o registro."];
            else if (Domain.LastWriterWins.IsClockAhead(request.ClientUpdatedAt.Value, time.GetUtcNow())) errors["clientUpdatedAt"] = ["O relógio do aparelho está mais de 24 horas à frente do servidor."];
        }
        if (errors.Count > 0) return ProblemDetailsExtensions.ValidationProblem(errors);
        var row = await handler.HandleAsync(id, userId, request!, ct);
        return row is null ? Results.Problem(statusCode: 404, title: "Registro da refeição não encontrado.", type: ProblemDetailsExtensions.TypeBase + "meal-not-found") : Results.Ok(row);
    }
}
