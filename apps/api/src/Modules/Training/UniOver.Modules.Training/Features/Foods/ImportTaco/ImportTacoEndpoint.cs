using System.Globalization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Domain.Foods;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Foods.ImportTaco;

internal sealed record TacoImportResponse(int Imported, IReadOnlyList<int> InvalidRows);

internal sealed class ImportTacoHandler(TrainingDbContext db, TimeProvider time)
{
    private static readonly string[] Headers = ["code", "name", "kcal_100g", "protein_g", "carb_g", "fat_g"];

    public async Task<TacoImportResponse> ImportAsync(string csv, CancellationToken ct)
    {
        var lines = csv.Split('\n');
        if (lines.Length == 0 || !ParseLine(lines[0].TrimEnd('\r')).SequenceEqual(Headers, StringComparer.OrdinalIgnoreCase))
            return new TacoImportResponse(0, [1]);
        var imported = 0;
        var invalid = new List<int>();
        for (var i = 1; i < lines.Length; i++)
        {
            var line = lines[i].TrimEnd('\r');
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                var cells = ParseLine(line);
                if (cells.Count != Headers.Length || string.IsNullOrWhiteSpace(cells[0]) || string.IsNullOrWhiteSpace(cells[1])
                    || cells[1].Length > FoodRules.NameMax
                    || !Number(cells[2], out var kcal) || !Number(cells[3], out var protein) || !Number(cells[4], out var carbs)
                    || !Number(cells[5], out var fat) || !FoodRules.IsValidMacro(kcal) || !FoodRules.IsValidMacro(protein)
                    || !FoodRules.IsValidMacro(carbs) || !FoodRules.IsValidMacro(fat))
                { invalid.Add(i + 1); continue; }
                var reference = cells[0].Trim();
                if (reference.Length > 160) { invalid.Add(i + 1); continue; }
                var now = Domain.TimeStamps.ToStorage(time.GetUtcNow());
                var row = await db.Set<Food>().SingleOrDefaultAsync(f => f.Source == FoodSources.Taco && f.SourceRef == reference, ct);
                row ??= new Food { Id = ExternalFoodIds.Create(FoodSources.Taco, reference), Source = FoodSources.Taco, SourceRef = reference, CreatedAt = now };
                row.OwnerUserId = null;
                row.Name = cells[1].Trim();
                row.Brand = null;
                row.KcalPer100g = kcal; row.ProteinPer100g = protein; row.CarbsPer100g = carbs; row.FatPer100g = fat;
                row.DefaultPortionGrams = null;
                row.Attribution = "Arquivo CSV fornecido pelo proprietário; origem/licença não verificadas pelo UniOver";
                row.ClientUpdatedAt = now; row.UpdatedAt = now; row.DeletedAt = null;
                if (db.Entry(row).State == EntityState.Detached) db.Set<Food>().Add(row);
                try { await db.SaveChangesAsync(ct); imported++; }
                catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: Npgsql.PostgresErrorCodes.UniqueViolation })
                {
                    db.ChangeTracker.Clear();
                    invalid.Add(i + 1);
                }
            }
            catch (FormatException) { invalid.Add(i + 1); }
        }
        return new TacoImportResponse(imported, invalid);
    }

    private static bool Number(string value, out decimal number) => decimal.TryParse(value, NumberStyles.AllowDecimalPoint | NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out number);

    private static List<string> ParseLine(string line)
    {
        var values = new List<string>(); var current = new System.Text.StringBuilder(); var quoted = false;
        for (var i = 0; i < line.Length; i++)
        {
            var c = line[i];
            if (c == '"' && quoted && i + 1 < line.Length && line[i + 1] == '"') { current.Append('"'); i++; }
            else if (c == '"') quoted = !quoted;
            else if (c == ',' && !quoted) { values.Add(current.ToString()); current.Clear(); }
            else current.Append(c);
        }
        if (quoted) throw new FormatException("CSV inválido.");
        values.Add(current.ToString());
        return values;
    }
}

internal static class ImportTacoEndpoint
{
    private const int MaxBytes = 1_000_000;
    public static void MapImportTaco(this IEndpointRouteBuilder group) => group.MapPost("/foods/imports/taco", HandleAsync)
        .WithMetadata(new RequestSizeLimitAttribute(MaxBytes + 16 * 1024)) // acima do teto geral da API (256 KiB); a rota confere o próprio 1 MiB
        .RequireAuthorization(UniOverAuth.OwnerPolicy).RequireRateLimiting(RateLimitPolicies.Commands)
        .RequireIdempotency<TrainingDbContext>().Produces<TacoImportResponse>().ProducesProblem(400).ProducesProblem(401)
        .ProducesProblem(403).ProducesProblem(413).ProducesProblem(415).ProducesProblem(429);

    private static async Task<IResult> HandleAsync(HttpRequest request, ICurrentUser current, ImportTacoHandler handler, CancellationToken ct)
    {
        if (current.UserId is null) return Results.Problem(statusCode: 401, title: "Sessão inválida ou expirada.");
        if (!request.ContentType?.StartsWith("text/csv", StringComparison.OrdinalIgnoreCase) ?? true) return Results.Problem(statusCode: 415, title: "Envie um arquivo text/csv.");
        if (request.ContentLength > MaxBytes) return Results.Problem(statusCode: 413, title: "O CSV deve ter até 1 MiB.");
        using var stream = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var read = await request.Body.ReadAsync(buffer, ct);
            if (read == 0) break;
            if (stream.Length + read > MaxBytes) return Results.Problem(statusCode: 413, title: "O CSV deve ter até 1 MiB.");
            stream.Write(buffer, 0, read);
        }
        string csv;
        try { csv = new System.Text.UTF8Encoding(false, true).GetString(stream.ToArray()); }
        catch (System.Text.DecoderFallbackException) { return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]> { ["file"] = ["O arquivo deve estar em UTF-8."] }); }
        return Results.Ok(await handler.ImportAsync(csv, ct));
    }
}
