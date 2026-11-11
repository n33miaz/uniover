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
    /// <param name="operationId">Opcional: o código da operação (<c>operationId</c>), só para agentes que o declararam.</param>
    /// <param name="deviceId">Opcional: o aparelho do app (<c>deviceId</c>), só para agentes que declararam <c>pc.device.v1</c>.</param>
    /// <param name="deviceName">Opcional: o nome do aparelho (<c>deviceName</c>).</param>
    public Result<OutboundEnvelope> Create(
        string type,
        string agentSlug,
        Guid? correlationId,
        JsonElement body,
        string? operationId = null,
        string? deviceId = null,
        string? deviceName = null)
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

            if (operationId is not null)
            {
                writer.WriteString("operationId", operationId);
            }

            if (deviceId is not null && deviceName is not null)
            {
                writer.WriteString("deviceId", deviceId);
                writer.WriteString("deviceName", deviceName);
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
