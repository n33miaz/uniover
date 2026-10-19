using System.Globalization;
using System.Text.Json;
using UniOver.SharedKernel;

namespace UniOver.BuildingBlocks.AgentProtocol;

/// <summary>Envelope de saída pronto para o transporte: o <c>id</c> gerado e o JSON em UTF-8.</summary>
public sealed record OutboundEnvelope(Guid Id, byte[] Json);

/// <summary>
/// Monta o envelope de saída (id UUID v7, <c>ts</c> em UTC) e só o devolve se o próprio validador o aceitar:
/// a API nunca emite uma mensagem que ela mesma recusaria.
/// </summary>
public sealed class OutboundEnvelopeFactory(AgentEnvelopeValidator validator, IClock clock)
{
    public const string ApiEndpoint = "api";

    /// <param name="type">Valor do campo <c>type</c> (ver <c>AgentMessageTypes</c>).</param>
    /// <param name="agentSlug">Slug do agente de destino (sem o prefixo <c>agent:</c>).</param>
    /// <param name="correlationId">Id da mensagem que esta responde, ou nulo.</param>
    /// <param name="body">Corpo da mensagem, como JSON.</param>
    public Result<OutboundEnvelope> Create(string type, string agentSlug, Guid? correlationId, JsonElement body)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(type);
        ArgumentException.ThrowIfNullOrWhiteSpace(agentSlug);

        var id = IdGenerator.NewId();
        var timestamp = clock.UtcNow.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteNumber("v", AgentEnvelopeValidator.SupportedVersion);
            writer.WriteString("id", id);
            writer.WriteString("type", type);
            writer.WriteString("source", ApiEndpoint);
            writer.WriteString("target", $"agent:{agentSlug}");
            writer.WriteString("ts", timestamp);
            if (correlationId is { } correlation)
            {
                writer.WriteString("correlationId", correlation);
            }
            else
            {
                writer.WriteNull("correlationId");
            }

            writer.WritePropertyName("body");
            body.WriteTo(writer);
            writer.WriteEndObject();
        }

        var json = stream.ToArray();
        var validation = validator.Validate(json);
        return validation.IsFailure
            ? Result.Failure<OutboundEnvelope>(validation.Error)
            : Result.Success(new OutboundEnvelope(id, json));
    }
}
