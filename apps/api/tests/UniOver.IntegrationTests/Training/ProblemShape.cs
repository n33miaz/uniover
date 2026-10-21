using System.Text.Json;
using System.Text.Json.Nodes;

namespace UniOver.IntegrationTests.Training;

/// <summary>
/// A "forma" de uma resposta de recusa, sem o que muda a cada pedido (<c>traceId</c> e <c>instance</c>): status, tipo de
/// conteúdo e corpo. Dois pedidos que o produto promete responder igual (o recurso de outra pessoa e o que não existe)
/// têm de produzir a mesma forma, senão a diferença vira uma pista sobre o que existe.
/// </summary>
internal static class ProblemShape
{
    public static async Task<string> OfAsync(HttpResponseMessage response)
    {
        ArgumentNullException.ThrowIfNull(response);

        var text = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        var body = text;
        try
        {
            if (JsonNode.Parse(text) is JsonObject json)
            {
                json.Remove("traceId");
                json.Remove("instance");
                body = json.ToJsonString();
            }
        }
        catch (JsonException)
        {
            // Corpo que não é JSON (ou vazio) vale como está.
        }

        return $"{(int)response.StatusCode}|{response.Content.Headers.ContentType?.MediaType}|{body}";
    }
}
