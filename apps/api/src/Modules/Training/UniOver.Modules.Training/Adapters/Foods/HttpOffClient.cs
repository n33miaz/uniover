using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Options;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Training;
using UniOver.Modules.Training.Ports.Foods;

namespace UniOver.Modules.Training.Adapters.Foods;

/// <summary>Cliente OFF com host e rotas fixos. O endpoint CGI é legado, porém é o único oficial documentado hoje com busca textual.</summary>
internal sealed class HttpOffClient(HttpClient http, IOptions<TrainingModuleOptions> options, ISystemSettings settings) : IOffClient
{
    private const string Host = "https://world.openfoodfacts.org";
    private static readonly string[] Fields = ["code", "product_name", "brands", "nutriments"];

    public async Task<OffSearchPage> SearchAsync(string query, CancellationToken cancellationToken)
    {
        await EnsureConfiguredAsync(cancellationToken);
        var url = $"{Host}/cgi/search.pl?search_simple=1&json=1&action=process&search_terms={Uri.EscapeDataString(query)}&fields={string.Join(',', Fields)}&page_size=20";
        using var response = await http.GetAsync(url, cancellationToken);
        EnsureSuccess(response);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(cancellationToken));
        if (!json.RootElement.TryGetProperty("products", out var products) || products.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("Resposta de busca OFF inválida.");
        return new OffSearchPage(products.EnumerateArray().Select(ParseProduct).Where(x => x is not null).Cast<OffFoodData>().ToArray());
    }

    public async Task<OffFoodData?> LookupAsync(string barcode, CancellationToken cancellationToken)
    {
        await EnsureConfiguredAsync(cancellationToken);
        var url = $"{Host}/api/v3.6/product/{Uri.EscapeDataString(barcode)}.json?fields={string.Join(',', Fields)}";
        using var response = await http.GetAsync(url, cancellationToken);
        EnsureSuccess(response);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(cancellationToken));
        if (json.RootElement.TryGetProperty("status", out var status) && status.ValueKind == JsonValueKind.Number && status.GetInt32() != 1)
            return null;
        return json.RootElement.TryGetProperty("product", out var product) ? ParseProduct(product) : null;
    }

    private async Task EnsureConfiguredAsync(CancellationToken cancellationToken)
    {
        var contact = await settings.OffContactAsync(cancellationToken);
        if (!OffContactRules.IsValid(contact)) throw new InvalidOperationException("OFF não configurado.");
        var version = string.IsNullOrWhiteSpace(options.Value.Version) ? "0.0.0" : options.Value.Version;
        http.DefaultRequestHeaders.UserAgent.Clear();
        http.DefaultRequestHeaders.UserAgent.ParseAdd($"UniOver/{version} ({contact})");
        http.DefaultRequestHeaders.Accept.ParseAdd("application/json");
    }

    private static void EnsureSuccess(HttpResponseMessage response)
    {
        if (response.IsSuccessStatusCode) return;
        var retry = response.Headers.RetryAfter?.Delta is { } delta
            ? (int)Math.Ceiling(delta.TotalSeconds)
            : 60;
        throw new OffUpstreamException(response.StatusCode, retry);
    }

    private static OffFoodData? ParseProduct(JsonElement product)
    {
        var barcode = GetString(product, "code");
        var name = GetString(product, "product_name");
        if (string.IsNullOrWhiteSpace(barcode) || string.IsNullOrWhiteSpace(name) || !product.TryGetProperty("nutriments", out var nutrients)) return null;
        var kcal = GetDecimal(nutrients, "energy-kcal_100g");
        if (kcal is null && GetDecimal(nutrients, "energy_100g") is { } kj) kcal = decimal.Round(kj / 4.184m, 2);
        var protein = GetDecimal(nutrients, "proteins_100g");
        var carbs = GetDecimal(nutrients, "carbohydrates_100g");
        var fat = GetDecimal(nutrients, "fat_100g");
        if (kcal is null || protein is null || carbs is null || fat is null) return null;
        return new OffFoodData(barcode, name.Trim(), GetString(product, "brands"), kcal.Value,
            protein.Value, carbs.Value, fat.Value);
    }

    private static string? GetString(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static decimal? GetDecimal(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value)) return null;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out var number)) return number;
        return value.ValueKind == JsonValueKind.String && decimal.TryParse(value.GetString(), NumberStyles.Number, CultureInfo.InvariantCulture, out number) ? number : null;
    }
}
