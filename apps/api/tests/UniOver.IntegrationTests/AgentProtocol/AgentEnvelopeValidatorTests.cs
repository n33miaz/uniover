using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using UniOver.BuildingBlocks.AgentProtocol;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.SharedKernel;

namespace UniOver.IntegrationTests.AgentProtocol;

/// <summary>Paridade do validador C# com os exemplos de <c>contracts/agent</c> (os mesmos que o ajv confere).</summary>
public class AgentEnvelopeValidatorTests
{
    private static readonly AgentEnvelopeValidator Validator = new();

    private static string ExamplesDirectory(string kind) =>
        Path.Combine(OpenApiContractTests.RepositoryRoot(), "contracts", "agent", "examples", kind);

    public static TheoryData<string> ValidExamples() => Examples("valid");

    public static TheoryData<string> InvalidExamples() => Examples("invalid");

    private static TheoryData<string> Examples(string kind)
    {
        var data = new TheoryData<string>();
        foreach (var file in Directory.GetFiles(ExamplesDirectory(kind), "*.json").Order(StringComparer.Ordinal))
        {
            data.Add(Path.GetFileName(file));
        }

        return data;
    }

    private static byte[] Read(string kind, string file) => File.ReadAllBytes(Path.Combine(ExamplesDirectory(kind), file));

    private static byte[] Valid(string type = "tv.key.v1") => Read("valid", $"{type}.json");

    /// <summary>Altera o exemplo válido e devolve o JSON resultante.</summary>
    private static byte[] Mutate(string type, Action<JsonObject> change)
    {
        var node = JsonNode.Parse(Valid(type))!.AsObject();
        change(node);
        return Encoding.UTF8.GetBytes(node.ToJsonString());
    }

    [Theory]
    [MemberData(nameof(ValidExamples))]
    public void Accepts_EveryValidExample(string file)
    {
        var result = Validator.Validate(Read("valid", file));

        result.IsSuccess.Should().BeTrue(result.IsFailure ? result.Error.Message : string.Empty);
        result.Value.Type.Should().Be(Path.GetFileNameWithoutExtension(file));
    }

    [Theory]
    [MemberData(nameof(InvalidExamples))]
    public void Rejects_EveryInvalidExample(string file)
    {
        var result = Validator.Validate(Read("invalid", file));

        result.IsFailure.Should().BeTrue();
    }

    [Fact]
    public void Accepts_ReturnsTheTypedEnvelopeFields()
    {
        var result = Validator.Validate(Valid("command.result.v1"));

        var envelope = result.Value;
        envelope.Source.Should().Be("agent:pc-casa");
        envelope.Target.Should().Be("api");
        envelope.CorrelationId.Should().NotBeNull();
        envelope.Timestamp.Offset.Should().Be(TimeSpan.Zero);
        envelope.Body.GetProperty("ok").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public void Rejects_UnknownType_WithItsOwnCode()
    {
        var json = Mutate("tv.key.v1", n => n["type"] = "tv.dance.v1");

        var result = Validator.Validate(json);

        result.Error.Code.Should().Be(AgentEnvelopeValidator.UnknownType);
    }

    [Theory]
    [InlineData(2)]
    [InlineData(0)]
    public void Rejects_UnsupportedEnvelopeVersion(int version)
    {
        var json = Mutate("tv.key.v1", n => n["v"] = version);

        var result = Validator.Validate(json);

        result.Error.Code.Should().Be(AgentEnvelopeValidator.UnsupportedVersion);
    }

    [Fact]
    public void Rejects_ExtraEnvelopeField()
    {
        var json = Mutate("tv.key.v1", n => n["extra"] = true);

        Validator.Validate(json).Error.Code.Should().Be(AgentEnvelopeValidator.SchemaViolation);
    }

    [Fact]
    public void Rejects_ExtraBodyField()
    {
        var json = Mutate("tv.key.v1", n => n["body"]!["extra"] = 1);

        Validator.Validate(json).Error.Code.Should().Be(AgentEnvelopeValidator.SchemaViolation);
    }

    [Theory]
    [InlineData("ontem")]
    [InlineData("2026-10-18T14:00:00")]
    [InlineData("2026-10-18T14:00:00-03:00")]
    [InlineData("2026-13-45T14:00:00Z")]
    public void Rejects_InvalidTimestamp(string ts)
    {
        var json = Mutate("tv.key.v1", n => n["ts"] = ts);

        Validator.Validate(json).Error.Code.Should().Be(AgentEnvelopeValidator.SchemaViolation);
    }

    [Fact]
    public void Rejects_MalformedJson_WithItsOwnCode()
    {
        var result = Validator.Validate("{ nao e json"u8);

        result.Error.Code.Should().Be(AgentEnvelopeValidator.InvalidJson);
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("42")]
    [InlineData("null")]
    public void Rejects_NonObjectRoot(string json)
    {
        Validator.Validate(Encoding.UTF8.GetBytes(json)).Error.Code.Should().Be(AgentEnvelopeValidator.SchemaViolation);
    }

    [Fact]
    public void Failure_DoesNotEchoTheReceivedContent()
    {
        const string secret = "valor-secreto-que-nao-pode-vazar";
        var json = Mutate("agent.hello.v1", n =>
        {
            n["body"]!["agentVersion"] = secret;
            n["body"]!["capabilities"] = new JsonArray(secret);
        });

        var result = Validator.Validate(json);

        result.IsFailure.Should().BeTrue();
        result.Error.Message.Should().NotContain(secret);
        result.Error.Message.Should().Contain("/body");
    }

    [Fact]
    public void KnownTypes_MatchTheSchemaFilesAndTheGeneratedConstants()
    {
        var schemas = Directory
            .GetFiles(Path.Combine(OpenApiContractTests.RepositoryRoot(), "contracts", "agent", "messages"), "*.schema.json")
            .Select(f => Path.GetFileName(f)[..^".schema.json".Length])
            .Order(StringComparer.Ordinal);

        Validator.KnownTypes.Should().Equal(schemas);
        AgentMessageTypes.All.Should().Equal(Validator.KnownTypes);
    }

    [Fact]
    public void GeneratedTypes_ReadAndWriteTheExamples()
    {
        var hello = AgentHelloV1Message.FromJson(Encoding.UTF8.GetString(Valid("agent.hello.v1")));
        hello!.Body.AgentVersion.Should().NotBeNullOrEmpty();
        hello.Type.Should().Be(AgentMessageTypes.AgentHelloV1);

        var state = TvStateV1Message.FromJson(Encoding.UTF8.GetString(Valid("tv.state.v1")));
        state!.Body.Connection.Should().Be(TvStateV1BodyConnection.Hot);
        state.ToJson().Should().Contain("\"connection\":\"hot\"");
    }

    [Fact]
    public void OutboundFactory_EmitsEnvelopesTheValidatorAccepts()
    {
        var clock = new FixedClock(new DateTimeOffset(2026, 10, 18, 14, 0, 0, 123, TimeSpan.Zero));
        var factory = new OutboundEnvelopeFactory(Validator, clock);
        using var body = JsonDocument.Parse("""{"key":"POWER"}""");
        var correlation = IdGenerator.NewId();

        var result = factory.Create(AgentMessageTypes.TvKeyV1, "pc-casa", correlation, body.RootElement);

        result.IsSuccess.Should().BeTrue();
        var accepted = Validator.Validate(result.Value.Json).Value;
        accepted.Id.Should().Be(result.Value.Id);
        accepted.Id.Version.Should().Be(7);
        accepted.Source.Should().Be("api");
        accepted.Target.Should().Be("agent:pc-casa");
        accepted.CorrelationId.Should().Be(correlation);
        accepted.Timestamp.Should().Be(clock.UtcNow);
    }

    [Fact]
    public void OutboundFactory_RefusesABodyTheContractDoesNotAllow()
    {
        var factory = new OutboundEnvelopeFactory(Validator, new FixedClock(DateTimeOffset.UtcNow));
        using var body = JsonDocument.Parse("""{"key":"TELEPORT"}""");

        var result = factory.Create(AgentMessageTypes.TvKeyV1, "pc-casa", null, body.RootElement);

        result.IsFailure.Should().BeTrue();
        result.Error.Code.Should().Be(AgentEnvelopeValidator.SchemaViolation);
    }

    [Fact]
    public void OutboundFactory_RefusesAnUnknownType()
    {
        var factory = new OutboundEnvelopeFactory(Validator, new FixedClock(DateTimeOffset.UtcNow));
        using var body = JsonDocument.Parse("{}");

        var result = factory.Create("tv.dance.v1", "pc-casa", null, body.RootElement);

        result.Error.Code.Should().Be(AgentEnvelopeValidator.UnknownType);
    }

    private sealed class FixedClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow => now;
    }
}
