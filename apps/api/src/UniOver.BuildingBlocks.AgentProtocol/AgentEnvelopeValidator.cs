using System.Reflection;
using System.Text.Json;
using Json.Schema;
using UniOver.SharedKernel;

namespace UniOver.BuildingBlocks.AgentProtocol;

/// <summary>
/// Valida uma mensagem do agente contra os JSON Schemas embutidos (envelope e, depois, o esquema do
/// <c>type</c>). As falhas trazem só código e o caminho do campo: nunca repetem o conteúdo recebido.
/// </summary>
public sealed class AgentEnvelopeValidator
{
    public const string InvalidJson = "invalid_json";
    public const string UnknownType = "unknown_type";
    public const string SchemaViolation = "schema_violation";
    public const string UnsupportedVersion = "unsupported_version";

    /// <summary>Única versão de envelope que esta API entende.</summary>
    public const int SupportedVersion = 1;

    private static readonly Lazy<SchemaSet> Shared = new(SchemaSet.Load);

    private readonly SchemaSet _schemas = Shared.Value;

    /// <summary>Tipos de mensagem que têm esquema, em ordem alfabética.</summary>
    public IReadOnlyCollection<string> KnownTypes => [.. _schemas.ByType.Keys.Order(StringComparer.Ordinal)];

    public Result<ValidatedEnvelope> Validate(ReadOnlySpan<byte> json)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json.ToArray());
        }
        catch (JsonException)
        {
            return Fail(InvalidJson, "O conteúdo não é um JSON válido.");
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return Fail(SchemaViolation, "A mensagem deve ser um objeto JSON.");
            }

            // Versão primeiro: um envelope de outra versão pode ter qualquer outro formato.
            if (root.TryGetProperty("v", out var version)
                && version.ValueKind == JsonValueKind.Number
                && !(version.TryGetInt32(out var number) && number == SupportedVersion))
            {
                return Fail(UnsupportedVersion, "Versão de envelope não suportada.");
            }

            var schemas = _schemas;
            var envelope = schemas.Envelope.Evaluate(root, schemas.Options);
            if (!envelope.IsValid)
            {
                return Fail(SchemaViolation, Describe("envelope", envelope));
            }

            var type = root.GetProperty("type").GetString()!;
            if (!schemas.ByType.TryGetValue(type, out var message))
            {
                return Fail(UnknownType, "Tipo de mensagem desconhecido.");
            }

            var result = message.Evaluate(root, schemas.Options);
            if (!result.IsValid)
            {
                return Fail(SchemaViolation, Describe(type, result));
            }

            var correlation = root.GetProperty("correlationId");
            return Result.Success(new ValidatedEnvelope(
                Id: root.GetProperty("id").GetGuid(),
                Type: type,
                Source: root.GetProperty("source").GetString()!,
                Target: root.GetProperty("target").GetString()!,
                Timestamp: root.GetProperty("ts").GetDateTimeOffset(),
                CorrelationId: correlation.ValueKind == JsonValueKind.Null ? null : correlation.GetGuid(),
                Body: root.GetProperty("body").Clone()));
        }
    }

    private static Result<ValidatedEnvelope> Fail(string code, string message) =>
        Result.Failure<ValidatedEnvelope>(new Error(code, message));

    /// <summary>Resume a falha só com o esquema e os caminhos dos campos recusados (sem valores).</summary>
    private static string Describe(string schema, EvaluationResults results)
    {
        var paths = new SortedSet<string>(StringComparer.Ordinal);
        Collect(results, paths);
        var where = paths.Count == 0 ? "/" : string.Join(", ", paths.Take(5));
        return $"A mensagem não cumpre o contrato ({schema}); campos: {where}.";
    }

    private static void Collect(EvaluationResults node, SortedSet<string> paths)
    {
        if (node.Errors is { Count: > 0 })
        {
            paths.Add(node.InstanceLocation.ToString());
        }

        foreach (var detail in node.Details ?? [])
        {
            Collect(detail, paths);
        }
    }

    private sealed class SchemaSet
    {
        public required JsonSchema Envelope { get; init; }

        public required IReadOnlyDictionary<string, JsonSchema> ByType { get; init; }

        public required EvaluationOptions Options { get; init; }

        public static SchemaSet Load()
        {
            var registry = new SchemaRegistry();
            var build = new BuildOptions { SchemaRegistry = registry };
            var assembly = typeof(AgentEnvelopeValidator).Assembly;

            var envelope = Read(assembly, "schemas/envelope.schema.json", build);
            var byType = new Dictionary<string, JsonSchema>(StringComparer.Ordinal);
            foreach (var name in assembly.GetManifestResourceNames().Order(StringComparer.Ordinal))
            {
                const string prefix = "schemas/messages/";
                const string suffix = ".schema.json";
                if (name.StartsWith(prefix, StringComparison.Ordinal) && name.EndsWith(suffix, StringComparison.Ordinal))
                {
                    var type = name[prefix.Length..^suffix.Length];
                    byType[type] = Read(assembly, name, build);
                }
            }

            return new SchemaSet
            {
                Envelope = envelope,
                ByType = byType,
                Options = new EvaluationOptions
                {
                    RequireFormatValidation = true,
                    OutputFormat = OutputFormat.Hierarchical,
                },
            };
        }

        private static JsonSchema Read(Assembly assembly, string resource, BuildOptions build)
        {
            using var stream = assembly.GetManifestResourceStream(resource)
                ?? throw new InvalidOperationException($"Esquema embutido ausente: {resource}");
            using var reader = new StreamReader(stream);
            return JsonSchema.FromText(reader.ReadToEnd(), build);
        }
    }
}

/// <summary>Envelope aceito: campos já tipados e o corpo ainda como JSON para quem sabe o <c>type</c>.</summary>
public sealed record ValidatedEnvelope(
    Guid Id,
    string Type,
    string Source,
    string Target,
    DateTimeOffset Timestamp,
    Guid? CorrelationId,
    JsonElement Body);
