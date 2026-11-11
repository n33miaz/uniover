using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using UniOver.IntegrationTests.Training;

namespace UniOver.IntegrationTests.Shopping;

/// <summary>Uma pessoa falando com o módulo de Compras: cada escrita sai com operação e chave de idempotência novas.</summary>
internal sealed class ShoppingClient(TrainingApp app, string accessToken)
{
    public const string Base = "/api/v1/shopping";

    public Task<HttpResponseMessage> GetAsync(string path) => app.SendAsync(HttpMethod.Get, Base + path, bearer: accessToken);

    /// <summary>Envia uma escrita. <paramref name="operationId"/> fixo simula o reenvio da mesma operação.</summary>
    public Task<HttpResponseMessage> WriteAsync(HttpMethod method, string path, Dictionary<string, object?> body, Guid? operationId = null)
    {
        body["operationId"] = operationId ?? Guid.NewGuid();
        return app.SendAsync(method, Base + path, body, accessToken, Guid.NewGuid());
    }

    public static async Task<JsonElement> OkAsync(Task<HttpResponseMessage> pending)
    {
        using var response = await pending;
        response.StatusCode.Should().Be(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        return await TrainingApp.JsonAsync(response);
    }

    public async Task<Guid> GroupIdAsync() => (await OkAsync(GetAsync("/group"))).GetProperty("id").GetGuid();

    public async Task<Guid> NewProductAsync(string name, string section = "Mercearia")
    {
        var id = Guid.NewGuid();
        await OkAsync(WriteAsync(HttpMethod.Put, $"/products/{id}", new() { ["name"] = name, ["section"] = section }));
        return id;
    }

    public async Task<Guid> NewListItemAsync(Guid productId, decimal quantity = 1, bool needed = true, string? note = null)
    {
        var id = Guid.NewGuid();
        await OkAsync(WriteAsync(
            HttpMethod.Put, $"/list-items/{id}", new() { ["productId"] = productId, ["quantity"] = quantity, ["needed"] = needed, ["note"] = note }));
        return id;
    }

    public async Task<Guid> OpenPurchaseAsync(decimal? budget = null)
    {
        var id = Guid.NewGuid();
        await OkAsync(WriteAsync(HttpMethod.Post, $"/purchases/{id}/open", new() { ["budget"] = budget }));
        return id;
    }

    public async Task<List<JsonElement>> ChangesAsync(long after = 0)
    {
        var body = await OkAsync(GetAsync($"/changes?after={after}"));
        return [.. body.GetProperty("items").EnumerateArray()];
    }
}
