using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Adapters.Foods;
using UniOver.Modules.Training.Domain.Foods;
using UniOver.Modules.Training.Persistence;
using UniOver.Modules.Training.Ports.Foods;

namespace UniOver.Modules.Training.Features.Foods.SearchOffFoods;

internal sealed class SearchOffFoodsHandler(IOffClient off, OffRateLimiter limiter, TrainingDbContext db,
    IOptions<TrainingModuleOptions> options, TimeProvider time)
{
    public async Task<(int Status, IReadOnlyList<FoodResponse>? Items, int Retry)> SearchAsync(string query, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(options.Value.Foods.OffContact)) return (503, null, 0);
        if (!limiter.TryAcquire(search: true, out var retry)) return (429, null, retry);
        try
        {
            var page = await off.SearchAsync(query, ct);
            var output = new List<FoodResponse>();
            foreach (var data in page.Items)
            {
                if (!Valid(data)) continue;
                output.Add(FoodResponse.From(await CacheAsync(data, ct)));
            }
            return (200, output, 0);
        }
        catch (OffUpstreamException ex)
        {
            return ((int)ex.StatusCode == 429 ? 429 : 502, null, ex.RetryAfterSeconds);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidDataException or System.Text.Json.JsonException)
        {
            return (502, null, 60);
        }
    }

    private async Task<Food> CacheAsync(OffFoodData data, CancellationToken ct)
    {
        var row = await db.Set<Food>().SingleOrDefaultAsync(f => f.Source == FoodSources.Off && f.SourceRef == data.Barcode, ct);
        var now = Domain.TimeStamps.ToStorage(time.GetUtcNow());
        row ??= new Food { Id = ExternalFoodIds.Create(FoodSources.Off, data.Barcode), Source = FoodSources.Off, SourceRef = data.Barcode, CreatedAt = now };
        row.OwnerUserId = null;
        row.Name = data.Name.Trim()[..Math.Min(data.Name.Trim().Length, FoodRules.NameMax)];
        row.Brand = string.IsNullOrWhiteSpace(data.Brand) ? null : data.Brand.Trim()[..Math.Min(data.Brand.Trim().Length, FoodRules.BrandMax)];
        row.Barcode = data.Barcode;
        row.KcalPer100g = decimal.Round(data.Kcal, 2);
        row.ProteinPer100g = decimal.Round(data.Protein, 2);
        row.CarbsPer100g = decimal.Round(data.Carbs, 2);
        row.FatPer100g = decimal.Round(data.Fat, 2);
        row.Attribution = "Open Food Facts, ODbL";
        row.UpdatedAt = now;
        row.ClientUpdatedAt = now;
        row.DeletedAt = null;
        if (db.Entry(row).State == EntityState.Detached) db.Set<Food>().Add(row);
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: Npgsql.PostgresErrorCodes.UniqueViolation })
        {
            db.ChangeTracker.Clear();
            row = await db.Set<Food>().SingleAsync(f => f.Source == FoodSources.Off && f.SourceRef == data.Barcode, ct);
        }
        return row;
    }

    private static bool Valid(OffFoodData d) => d.Barcode.Length is >= 8 and <= 14 && d.Barcode.All(char.IsAsciiDigit)
        && !string.IsNullOrWhiteSpace(d.Name) && d.Name.Length <= 500 && FoodRules.IsValidMacro(d.Kcal)
        && FoodRules.IsValidMacro(d.Protein) && FoodRules.IsValidMacro(d.Carbs) && FoodRules.IsValidMacro(d.Fat);
}

internal static class SearchOffFoodsEndpoint
{
    public static void MapSearchOffFoods(this IEndpointRouteBuilder group) => group.MapGet("/foods/off/search", HandleAsync)
        .RequireAuthorization(TrainingAuth.Module).Produces<IReadOnlyList<FoodResponse>>().ProducesProblem(400)
        .ProducesProblem(401).ProducesProblem(429).ProducesProblem(502).ProducesProblem(503);

    private static async Task<IResult> HandleAsync(string? q, SearchOffFoodsHandler handler, HttpContext http, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(q) || q.Trim().Length is < 2 or > 80 || q.Any(char.IsControl))
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]> { ["q"] = ["A busca deve ter de 2 a 80 caracteres."] });
        var result = await handler.SearchAsync(q.Trim(), ct);
        return ToResult(result.Status, result.Items, result.Retry, http);
    }

    internal static IResult ToResult<T>(int status, T? body, int retry, HttpContext http)
    {
        if (status == 200) return Results.Ok(body);
        if (retry > 0) http.Response.Headers.RetryAfter = retry.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var type = status == 503 ? "off-not-configured" : "upstream-unavailable";
        return Results.Problem(statusCode: status, title: status == 503 ? "Busca OFF não configurada." : status == 429 ? "Limite de consultas OFF atingido." : "O serviço de alimentos está indisponível.", type: ProblemDetailsExtensions.TypeBase + type);
    }
}
