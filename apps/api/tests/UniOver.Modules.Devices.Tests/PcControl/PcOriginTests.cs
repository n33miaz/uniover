using System.Text.Json;
using AwesomeAssertions;
using Microsoft.AspNetCore.Http;
using UniOver.BuildingBlocks.AgentProtocol;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.GetModuleInfo;
using UniOver.Modules.Devices.Features.PcControl;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Tests.PcControl;

/// <summary>A operação e o aparelho que acompanham um comando do PC: de onde vêm, quando saem e o que nunca levam.</summary>
public sealed class PcOriginTests
{
    private static readonly JsonElement Body = JsonDocument.Parse("""{"key":"ENTER"}""").RootElement.Clone();
    private static readonly PcOrigin Origin = new("0192f1e47b3a7c2e", "3fa9c10d7be2465a3fa9c10d7be2465a", "iPhone (Safari)");

    private static OutboundMessage Message() => new("pc.key.v1", Body, AgentDelivery.Immediate);

    [Fact]
    public void AnAgentThatDeclaresBothGetsTheOperationAndTheDevice()
    {
        var sent = PcMessages.WithOrigin(Message(), [PcMessages.OperationCapability, PcMessages.DeviceCapability], Origin, withOperation: true);

        sent.OperationId.Should().Be("0192f1e47b3a7c2e");
        sent.DeviceId.Should().Be("3fa9c10d7be2465a3fa9c10d7be2465a");
        sent.DeviceName.Should().Be("iPhone (Safari)");
        sent.Body.GetRawText().Should().Be(Body.GetRawText(), "o corpo nunca muda: operação e aparelho vão no envelope");
    }

    [Fact]
    public void AnOlderAgentGetsNeitherBecauseItsEnvelopeIsClosed()
    {
        var sent = PcMessages.WithOrigin(Message(), ["pc.control.v1", "pc.key.v2"], Origin, withOperation: true);

        sent.OperationId.Should().BeNull();
        sent.DeviceId.Should().BeNull();
        sent.DeviceName.Should().BeNull();
    }

    [Fact]
    public void EachCapabilityGatesOnlyItsOwnField()
    {
        var onlyOperation = PcMessages.WithOrigin(Message(), [PcMessages.OperationCapability], Origin, withOperation: true);
        var onlyDevice = PcMessages.WithOrigin(Message(), [PcMessages.DeviceCapability], Origin, withOperation: true);

        (onlyOperation.OperationId, onlyOperation.DeviceId).Should().Be(("0192f1e47b3a7c2e", null));
        (onlyDevice.OperationId, onlyDevice.DeviceId).Should().Be((null, "3fa9c10d7be2465a3fa9c10d7be2465a"));
    }

    [Fact]
    public void TheHighRateMessageNeverCarriesTheOperation()
    {
        var sent = PcMessages.WithOrigin(Message(), [PcMessages.OperationCapability, PcMessages.DeviceCapability], Origin, withOperation: false);

        sent.OperationId.Should().BeNull();
        sent.DeviceId.Should().NotBeNull("a aprovação vale para o movimento também");
    }

    [Fact]
    public void WithoutASessionThereIsNoDeviceToApprove()
    {
        var sent = PcMessages.WithOrigin(
            Message(), [PcMessages.DeviceCapability], Origin with { DeviceId = null }, withOperation: true);

        (sent.DeviceId, sent.DeviceName).Should().Be((null, null));
    }

    [Theory]
    [InlineData("0192f1e47b3a7c2e", true)]
    [InlineData("abcDEF12_-xyz", true)]
    [InlineData("curto", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    [InlineData("tecla A pressionada agora", false)]
    [InlineData("com/barra/ou.ponto", false)]
    [InlineData("0123456789012345678901234567890123456789x", false)]
    public void OnlyACodeInTheContractFormatIsKept(string? value, bool valid) =>
        PcOriginReader.IsOperationId(value).Should().Be(valid);

    [Fact]
    public void AMadeUpOperationHasTheContractFormat() =>
        PcOriginReader.IsOperationId(PcOriginReader.NewOperationId()).Should().BeTrue();

    [Theory]
    [InlineData("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "iPhone (Safari)")]
    [InlineData("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1", "iPhone (Chrome)")]
    [InlineData("Mozilla/5.0 (Linux; Android 15; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36", "Android (Chrome)")]
    [InlineData("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0", "Windows (Edge)")]
    [InlineData("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "Mac (Safari)")]
    [InlineData("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "Linux (Firefox)")]
    [InlineData("curl/8.5.0", "Aparelho desconhecido")]
    [InlineData("", "Aparelho desconhecido")]
    [InlineData(null, "Aparelho desconhecido")]
    public void TheDeviceNameComesFromTheBrowserWithoutRepeatingItsText(string? userAgent, string expected)
    {
        var label = DeviceLabels.From(userAgent);

        label.Should().Be(expected);
        label.Length.Should().BeLessThanOrEqualTo(60);
    }

    [Fact]
    public void TheEnvelopeFactoryWritesTheFieldsOnlyWhenAskedAndTheContractAcceptsThem()
    {
        var factory = new OutboundEnvelopeFactory(new AgentEnvelopeValidator(), new SystemClock());
        var body = JsonDocument.Parse("""{"button":"LEFT"}""").RootElement.Clone();

        var plain = factory.Create("pc.click.v1", "pc-casa", null, body);
        var full = factory.Create("pc.click.v1", "pc-casa", null, body, "0192f1e47b3a7c2e", "3fa9c10d7be2465a", "iPhone (Safari)");
        var halfDevice = factory.Create("pc.click.v1", "pc-casa", null, body, deviceId: "3fa9c10d7be2465a");

        plain.IsSuccess.Should().BeTrue();
        full.IsSuccess.Should().BeTrue(full.IsFailure ? full.Error.Code : "");
        halfDevice.IsSuccess.Should().BeTrue();
        using var plainJson = JsonDocument.Parse(plain.Value.Json);
        plainJson.RootElement.TryGetProperty("operationId", out _).Should().BeFalse();
        using var fullJson = JsonDocument.Parse(full.Value.Json);
        fullJson.RootElement.GetProperty("operationId").GetString().Should().Be("0192f1e47b3a7c2e");
        fullJson.RootElement.GetProperty("deviceName").GetString().Should().Be("iPhone (Safari)");
        // Aparelho sem nome não sai (os dois vão juntos, como no contrato).
        using var halfJson = JsonDocument.Parse(halfDevice.Value.Json);
        halfJson.RootElement.TryGetProperty("deviceId", out _).Should().BeFalse();
    }

    [Fact]
    public void ARefusedDevice_IsA403_AndTellsPendingFromDenied()
    {
        var denied = PcProblems.DeviceRefused(PcProblems.DeviceDeniedCode);
        var pending = PcProblems.DeviceRefused(PcProblems.DevicePendingCode);

        ((IStatusCodeHttpResult)denied).StatusCode.Should().Be(StatusCodes.Status403Forbidden);
        ((IStatusCodeHttpResult)pending).StatusCode.Should().Be(StatusCodes.Status403Forbidden);
        ((Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult)denied).ProblemDetails.Type.Should().EndWith("pc-device-denied");
        ((Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult)pending).ProblemDetails.Type.Should().EndWith("pc-device-pending");
        PcProblems.IsDeviceRefusal("device_denied").Should().BeTrue();
        PcProblems.IsDeviceRefusal("device_pending").Should().BeTrue();
        PcProblems.IsDeviceRefusal("failed").Should().BeFalse();
        PcProblems.IsDeviceRefusal(null).Should().BeFalse();
    }

    [Fact]
    public void TheApiListsTheNewCapabilitiesSoTheAgentMayDeclareThem() =>
        GetModuleInfoHandler.AgentFeatures.Should().Contain([PcMessages.OperationCapability, PcMessages.DeviceCapability]);

    [Fact]
    public void ARevocationThatDidNotReachTheAgentStaysMarkedUntilItComesBack()
    {
        var sessions = new PcRtcSessions(TimeProvider.System);
        var userId = Guid.NewGuid();
        var first = sessions.Open(userId, Guid.NewGuid(), "pc-casa");
        var second = sessions.Open(userId, Guid.NewGuid(), "pc-casa");
        var other = sessions.Open(userId, Guid.NewGuid(), "outro-pc");

        sessions.RevokePendingForAgent("pc-casa").Should().BeEmpty();
        sessions.MarkRevokePending(first.Id);
        sessions.MarkRevokePending(other.Id);

        sessions.RevokePendingForAgent("pc-casa").Select(s => s.Id).Should().Equal(first.Id);
        sessions.Get(first.Id, userId, negotiating: false).Should().NotBeNull("só sai do registro depois de o aviso chegar");
        sessions.Get(second.Id, userId, negotiating: false)!.RevokePending.Should().BeFalse();

        sessions.TakeOwned(first.Id, userId);
        sessions.RevokePendingForAgent("pc-casa").Should().BeEmpty();
    }

    [Fact]
    public void ADeviceStateIsHeldBrieflyAndApprovedClearsIt()
    {
        var clock = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-10T14:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var states = new PcDeviceStates(clock);

        states.RefusalFor("pc-casa", "dev1").Should().BeNull();
        states.Set("pc-casa", "dev1", "pending");
        states.Set("pc-casa", "dev2", "denied");

        states.RefusalFor("pc-casa", "dev1").Should().Be("device_pending");
        states.RefusalFor("pc-casa", "dev2").Should().Be("device_denied");
        states.RefusalFor("outro-pc", "dev1").Should().BeNull("o aviso é por agente");

        clock.Advance(PcDeviceStates.Validity - TimeSpan.FromSeconds(1));
        states.RefusalFor("pc-casa", "dev1").Should().Be("device_pending");
        states.Set("pc-casa", "dev1", "pending"); // o agente renova
        clock.Advance(TimeSpan.FromSeconds(5));
        states.RefusalFor("pc-casa", "dev1").Should().Be("device_pending");
        states.RefusalFor("pc-casa", "dev2").Should().BeNull("sem renovação o aviso vence");

        states.Set("pc-casa", "dev1", "approved");
        states.RefusalFor("pc-casa", "dev1").Should().BeNull();
    }

    [Fact]
    public void TheDeviceStatesOfAnAgentThatDroppedAreForgotten()
    {
        var states = new PcDeviceStates(TimeProvider.System);
        states.Set("pc-casa", "dev1", "pending");
        states.Set("outro-pc", "dev1", "pending");

        states.OnPresenceChanged(new UniOver.Modules.Devices.Contracts.Agents.AgentPresenceInfo("pc-casa", false, null, null, [], null));

        states.RefusalFor("pc-casa", "dev1").Should().BeNull();
        states.RefusalFor("outro-pc", "dev1").Should().Be("device_pending");
    }

    [Fact]
    public void TheMemoryOfDeviceStatesIsBounded()
    {
        var states = new PcDeviceStates(TimeProvider.System);
        for (var i = 0; i < 1000; i++)
        {
            states.Set("pc-casa", $"dev{i}", "pending");
        }

        Enumerable.Range(0, 1000).Count(i => states.RefusalFor("pc-casa", $"dev{i}") is not null).Should().BeLessThanOrEqualTo(256);
    }

    [Fact]
    public void AnUnknownDeviceIsA403WithItsOwnType() =>
        ((Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult)PcProblems.DeviceRefused(PcProblems.DeviceUnknownCode)).ProblemDetails.Type
            .Should().EndWith("pc-device-unknown");

    [Fact]
    public void TheSessionsOfAPcCanBeListedWithoutTakingThem()
    {
        var sessions = new PcRtcSessions(TimeProvider.System);
        var userId = Guid.NewGuid();
        var mine = sessions.Open(userId, Guid.NewGuid(), "pc-casa");
        sessions.Open(userId, Guid.NewGuid(), "outro-pc");

        sessions.ForAgent("pc-casa").Select(s => s.Id).Should().Equal(mine.Id);
        sessions.ForAgent("pc-casa").Should().HaveCount(1, "listar não tira: a oferta recusada nunca derruba o canal");
        sessions.Get(mine.Id, userId, negotiating: false).Should().NotBeNull();
    }
}
