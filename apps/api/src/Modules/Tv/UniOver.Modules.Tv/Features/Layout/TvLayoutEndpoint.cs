using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Persistence;

namespace UniOver.Modules.Tv.Features.Layout;

internal sealed record TvLayoutDocument(
    string Name, string ButtonSize, bool ShowMedia, bool ShowChannel, string StartPage,
    string PadSpeed, string PillLayout, IReadOnlyList<string>? ExtraKeys, IReadOnlyList<string> DismissedSuggestions);

internal static class TvLayoutValidator
{
    private static readonly HashSet<string> Fields =
        ["name", "buttonSize", "showMedia", "showChannel", "startPage", "padSpeed", "pillLayout", "extraKeys", "dismissedSuggestions"];
    private static readonly HashSet<string> ExtraKeys =
        ["INPUT", "GUIDE", "INFO", "TOOLS", "CHANNEL_LIST", "EXIT", "PREVIOUS_CHANNEL", "SUBTITLE",
            "PLAY", "PAUSE", "STOP", "REWIND", "FAST_FORWARD", "ASPECT", "SLEEP", "E_MANUAL",
            "RED", "GREEN", "YELLOW", "BLUE"];

    public static bool TryParse(JsonElement body, out TvLayoutDocument? document)
    {
        document = null;
        if (body.ValueKind != JsonValueKind.Object || body.EnumerateObject().Any(p => !Fields.Contains(p.Name))) return false;
        if (!Text(body, "name", out var name) || name!.Length > 20 ||
            !Choice(body, "buttonSize", ["compact", "comfortable", "large"], out var buttonSize) ||
            !Flag(body, "showMedia", out var showMedia) || !Flag(body, "showChannel", out var showChannel) ||
            !Choice(body, "startPage", ["directions", "numbers", "touchpad", "last"], out var startPage) ||
            !Choice(body, "padSpeed", ["slow", "normal", "fast"], out var padSpeed) ||
            !Choice(body, "pillLayout", ["sides", "row"], out var pillLayout) ||
            !List(body, "extraKeys", 8, 32, true, out var extraKeys) ||
            (extraKeys is not null && extraKeys.Any(key => !ExtraKeys.Contains(key))) ||
            !List(body, "dismissedSuggestions", 20, 100, false, out var dismissed)) return false;

        document = new TvLayoutDocument(name!, buttonSize!, showMedia, showChannel, startPage!, padSpeed!, pillLayout!, extraKeys, dismissed!);
        return true;
    }

    private static bool Text(JsonElement body, string key, out string? value)
    {
        value = null;
        if (!body.TryGetProperty(key, out var item) || item.ValueKind != JsonValueKind.String) return false;
        value = item.GetString();
        return value is not null && !value.Any(char.IsControl);
    }

    private static bool Choice(JsonElement body, string key, HashSet<string> allowed, out string? value) =>
        Text(body, key, out value) && allowed.Contains(value!);

    private static bool Flag(JsonElement body, string key, out bool value)
    {
        value = false;
        if (!body.TryGetProperty(key, out var item) || item.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return false;
        value = item.GetBoolean();
        return true;
    }

    private static bool List(JsonElement body, string key, int max, int textMax, bool nullable, out IReadOnlyList<string>? value)
    {
        value = null;
        if (!body.TryGetProperty(key, out var item)) return false;
        if (nullable && item.ValueKind == JsonValueKind.Null) return true;
        if (item.ValueKind != JsonValueKind.Array || item.GetArrayLength() > max) return false;
        var items = new List<string>();
        foreach (var element in item.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.String || element.GetString() is not { Length: > 0 } text ||
                text.Length > textMax || text.Any(char.IsControl) || items.Contains(text, StringComparer.Ordinal)) return false;
            items.Add(text);
        }
        value = items;
        return true;
    }
}

internal static class TvLayoutEndpoint
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static void MapTvLayout(this IEndpointRouteBuilder group)
    {
        group.MapGet("/layout", GetAsync).RequireAuthorization(TvAuth.Module)
            .Produces<TvLayoutDocument>().Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPost("/layout", SeedAsync).RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Accepts<TvLayoutDocument>("application/json")
            .Produces<TvLayoutDocument>().ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status409Conflict);
        group.MapPut("/layout", PutAsync).RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Accepts<TvLayoutDocument>("application/json")
            .Produces<TvLayoutDocument>().ProducesProblem(StatusCodes.Status400BadRequest);
    }

    private static async Task<IResult> GetAsync(ITvCurrentSelection selection, TvDbContext db, CancellationToken ct)
    {
        var json = await db.TvLayouts.AsNoTracking().Where(x => x.TvId == selection.Current.Id)
            .Select(x => x.Document).SingleOrDefaultAsync(ct);
        return json is null ? TypedResults.NoContent() : TypedResults.Ok(JsonSerializer.Deserialize<TvLayoutDocument>(json, Json));
    }

    private static async Task<IResult> SeedAsync(JsonElement body, ITvCurrentSelection selection, TvDbContext db, TimeProvider time, CancellationToken ct)
    {
        if (!TvLayoutValidator.TryParse(body, out var document)) return Invalid();
        if (!selection.Current.IsPersisted) return TypedResults.Conflict();
        var json = JsonSerializer.Serialize(document, Json);
        // A restrição de chave primária arbitra duas primeiras cargas ao mesmo tempo sem substituir a primeira base.
        var inserted = await db.Database.ExecuteSqlInterpolatedAsync(
            $"INSERT INTO tv.tv_layouts (tv_id, document, updated_at) VALUES ({selection.Current.Id}, CAST({json} AS jsonb), {time.GetUtcNow()}) ON CONFLICT (tv_id) DO NOTHING", ct);
        return inserted == 0 ? TypedResults.Conflict() : TypedResults.Ok(document);
    }

    private static async Task<IResult> PutAsync(JsonElement body, ITvCurrentSelection selection, TvDbContext db, TimeProvider time, CancellationToken ct)
    {
        if (!TvLayoutValidator.TryParse(body, out var document)) return Invalid();
        if (!selection.Current.IsPersisted) return TypedResults.NotFound();
        var json = JsonSerializer.Serialize(document, Json);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"INSERT INTO tv.tv_layouts (tv_id, document, updated_at) VALUES ({selection.Current.Id}, CAST({json} AS jsonb), {time.GetUtcNow()}) ON CONFLICT (tv_id) DO UPDATE SET document = EXCLUDED.document, updated_at = EXCLUDED.updated_at", ct);
        return TypedResults.Ok(document);
    }

    private static ProblemHttpResult Invalid() => ProblemDetailsExtensions.ValidationProblem(
        new Dictionary<string, string[]> { ["body"] = ["A configuração da TV tem campos inválidos."] });
}
