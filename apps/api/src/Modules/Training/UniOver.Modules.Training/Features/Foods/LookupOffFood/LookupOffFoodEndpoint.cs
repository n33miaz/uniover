using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Adapters.Foods;
using UniOver.Modules.Training.Domain.Foods;
using UniOver.Modules.Training.Features.Foods.SearchOffFoods;
using UniOver.Modules.Training.Persistence;
using UniOver.Modules.Training.Ports.Foods;

namespace UniOver.Modules.Training.Features.Foods.LookupOffFood;

internal sealed class LookupOffFoodHandler(IOffClient off, OffRateLimiter limiter, TrainingDbContext db,
    IOptions<TrainingModuleOptions> options, TimeProvider time)
{
    public async Task<(int Status, FoodResponse? Food, int Retry)> LookupAsync(string barcode, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(options.Value.Foods.OffContact)) return (503, null, 0);
        var cached = await db.Set<Food>().AsNoTracking().SingleOrDefaultAsync(f => f.Source == FoodSources.Off && f.SourceRef == barcode && f.DeletedAt == null, ct);
        if (cached is not null) return (200, FoodResponse.From(cached), 0);
        if (!limiter.TryAcquire(search: false, out var retry)) return (429, null, retry);
        try
        {
            var data = await off.LookupAsync(barcode, ct);
            if (data is null) return (404, null, 0);
            if (data.Barcode != barcode || string.IsNullOrWhiteSpace(data.Name) || data.Name.Length > 500
                || !FoodRules.IsValidMacro(data.Kcal) || !FoodRules.IsValidMacro(data.Protein) || !FoodRules.IsValidMacro(data.Carbs) || !FoodRules.IsValidMacro(data.Fat))
                return (502, null, 60);
            var now = Domain.TimeStamps.ToStorage(time.GetUtcNow());
            var row = new Food { Id = ExternalFoodIds.Create(FoodSources.Off, barcode), Source = FoodSources.Off, SourceRef = barcode,
                Name = data.Name.Trim()[..Math.Min(data.Name.Trim().Length, FoodRules.NameMax)], Brand = data.Brand?.Trim()[..Math.Min(data.Brand.Trim().Length, FoodRules.BrandMax)],
                Barcode = barcode, KcalPer100g = data.Kcal, ProteinPer100g = data.Protein, CarbsPer100g = data.Carbs, FatPer100g = data.Fat,
                Attribution = "Open Food Facts, ODbL", CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now };
            db.Set<Food>().Add(row);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: Npgsql.PostgresErrorCodes.UniqueViolation })
            {
                db.ChangeTracker.Clear();
                row = await db.Set<Food>().SingleAsync(f => f.Source == FoodSources.Off && f.SourceRef == barcode, ct);
            }
            return (200, FoodResponse.From(row), 0);
        }
        catch (OffUpstreamException ex) { return ((int)ex.StatusCode == 429 ? 429 : 502, null, ex.RetryAfterSeconds); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidDataException or System.Text.Json.JsonException) { return (502, null, 60); }
    }
}

internal static class LookupOffFoodEndpoint
{
    public static void MapLookupOffFood(this IEndpointRouteBuilder group) => group.MapGet("/foods/off/barcode/{barcode}", HandleAsync)
        .RequireAuthorization(TrainingAuth.Module).Produces<FoodResponse>().ProducesProblem(400).ProducesProblem(401)
        .ProducesProblem(404).ProducesProblem(429).ProducesProblem(502).ProducesProblem(503);

    private static async Task<IResult> HandleAsync(string barcode, LookupOffFoodHandler handler, HttpContext http, CancellationToken ct)
    {
        if (barcode.Length is < 8 or > 14 || barcode.Any(c => !char.IsAsciiDigit(c)))
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]> { ["barcode"] = ["O código deve ter de 8 a 14 dígitos."] });
        var result = await handler.LookupAsync(barcode, ct);
        if (result.Status == 404) return Results.Problem(statusCode: 404, title: "Produto não encontrado no OFF.", type: ProblemDetailsExtensions.TypeBase + "off-food-not-found");
        return SearchOffFoodsEndpoint.ToResult(result.Status, result.Food, result.Retry, http);
    }
}
