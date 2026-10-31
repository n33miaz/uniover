using System.Text.Json;
using AwesomeAssertions;
using UniOver.BuildingBlocks.AgentProtocol;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.PcControl;

namespace UniOver.Modules.Devices.Tests.PcControl;

public sealed class PcMessagesTests
{
    private static readonly AgentEnvelopeValidator Validator = new();

    /// <summary>O envelope que o gateway monta em volta do corpo, para provar que o corpo cumpre o esquema do contrato.</summary>
    private static bool IsValidForTheContract(OutboundMessage message)
    {
        var envelope = JsonSerializer.Serialize(new
        {
            v = 1,
            id = Guid.CreateVersion7(),
            type = message.Type,
            source = "api",
            target = "agent:pc-casa",
            ts = "2026-11-01T14:00:00Z",
            correlationId = (Guid?)null,
            body = message.Body,
        });
        return Validator.Validate(System.Text.Encoding.UTF8.GetBytes(envelope)).IsSuccess;
    }

    [Fact]
    public void EveryMessageBuiltHereCarriesTheTypeAndTheBodyOfTheContract()
    {
        var all = new (OutboundMessage Message, string Type)[]
        {
            (PcMessages.Pointer(12, -4, 0, 120), "pc.pointer.v1"),
            (PcMessages.Click(PcClickV1BodyButton.Right, PcClickV1BodyAction.Double), "pc.click.v1"),
            (PcMessages.Key(PcKeyV1BodyKey.C, [PcKeyV1BodyModifiersItem.Ctrl, PcKeyV1BodyModifiersItem.Shift]), "pc.key.v1"),
            (PcMessages.Text("olá, mundo"), "pc.text.v1"),
            (PcMessages.Media(PcMediaV1BodyAction.VolumeUp, 3), "pc.media.v1"),
            (PcMessages.Power(PcPowerV1BodyAction.CancelShutdown), "pc.power.v1"),
            (PcMessages.AppLaunch("navegador"), "pc.app.launch.v1"),
        };

        foreach (var (message, type) in all)
        {
            message.Type.Should().Be(type);
            IsValidForTheContract(message).Should().BeTrue($"o corpo de {type} cumpre o esquema: {message.Body.GetRawText()}");
        }
    }

    [Fact]
    public void Pointer_LeavesOutTheScrollThatIsZero()
    {
        PcMessages.Pointer(3, -2, 0, 0).Body.GetRawText().Should().Be("{\"dx\":3,\"dy\":-2}");
        PcMessages.Pointer(0, 0, -240, 120).Body.GetRawText().Should().Be("{\"dx\":0,\"dy\":0,\"scrollX\":-240,\"scrollY\":120}");
    }

    [Fact]
    public void Media_LeavesOutTheStepsThatAreTheDefault()
    {
        PcMessages.Media(PcMediaV1BodyAction.Mute, 1).Body.GetRawText().Should().Be("{\"action\":\"MUTE\"}");
        PcMessages.Media(PcMediaV1BodyAction.VolumeDown, 2).Body.GetRawText().Should().Contain("\"steps\":2");
    }

    [Fact]
    public void TheWireNamesAreExactlyTheOnesOfTheContract()
    {
        PcMessages.Buttons.Keys.Should().BeEquivalentTo("LEFT", "RIGHT", "MIDDLE");
        PcMessages.ClickActions.Keys.Should().BeEquivalentTo("CLICK", "DOUBLE", "DOWN", "UP");
        PcMessages.Modifiers.Keys.Should().BeEquivalentTo("CTRL", "ALT", "SHIFT", "WIN");
        PcMessages.MediaActions.Keys.Should().BeEquivalentTo(
            "PLAY_PAUSE", "NEXT", "PREVIOUS", "STOP", "VOLUME_UP", "VOLUME_DOWN", "MUTE");
        PcMessages.PowerActions.Keys.Should().BeEquivalentTo("LOCK", "SLEEP", "SHUTDOWN", "CANCEL_SHUTDOWN");
        PcMessages.Keys.Keys.Should().Contain(["ENTER", "BACKSPACE", "PAGE_UP", "PAGE_DOWN", "F1", "F12", "A", "Z"]);
        PcMessages.Keys.Should().HaveCount(14 + 12 + 26);
    }

    [Fact]
    public void TheContractRefusesWhatTheApiMustNeverBuild()
    {
        var bad = new OutboundMessage(AgentMessageTypes.PcAppLaunchV1, JsonDocument.Parse("{\"appId\":\"C:\\\\Windows\\\\notepad.exe\"}").RootElement.Clone());
        IsValidForTheContract(bad).Should().BeFalse("o corpo nunca leva caminho de programa");
    }

    [Fact]
    public void Capability_IsTheOneTheHelloDeclares() => PcMessages.Capability.Should().Be("pc.control.v1");
}

public sealed class PcValidatorTests
{
    [Theory]
    [InlineData(0, 0, true)]
    [InlineData(2000, -2000, true)]
    [InlineData(2001, 0, false)]
    [InlineData(0, -2001, false)]
    public void Pointer_RespectsTheLimitsOfTheContract(int dx, int dy, bool valid) =>
        PcValidator.Pointer(new PcPointerRequest(dx, dy, null, null)).Count.Should().Be(valid ? 0 : 1);

    [Fact]
    public void Pointer_NeedsBothAxes_AndLimitsTheScroll()
    {
        PcValidator.Pointer(new PcPointerRequest(1, null, null, null)).Should().ContainKey("dy");
        PcValidator.Pointer(new PcPointerRequest(null, null, null, null)).Should().HaveCount(2);
        PcValidator.Pointer(new PcPointerRequest(1, 1, 1201, null)).Should().ContainKey("scrollX");
        PcValidator.Pointer(new PcPointerRequest(1, 1, null, -1201)).Should().ContainKey("scrollY");
        PcValidator.Pointer(new PcPointerRequest(1, 1, 1200, -1200)).Should().BeEmpty();
        PcValidator.Pointer(null).Should().HaveCount(2);
    }

    [Fact]
    public void Click_AcceptsOnlyTheClosedLists()
    {
        PcValidator.Click(new PcClickRequest("LEFT", null)).Should().BeEmpty();
        PcValidator.Click(new PcClickRequest("RIGHT", "DOUBLE")).Should().BeEmpty();
        PcValidator.Click(new PcClickRequest("left", null)).Should().ContainKey("button");
        PcValidator.Click(new PcClickRequest("LEFT", "TRIPLE")).Should().ContainKey("action");
        PcValidator.Click(null).Should().ContainKey("button");
    }

    [Fact]
    public void Key_AcceptsOnlyTheClosedListAndNeverRepeatsAModifier()
    {
        PcValidator.Key(new PcKeyRequest("C", ["CTRL"])).Should().BeEmpty();
        PcValidator.Key(new PcKeyRequest("ENTER", null)).Should().BeEmpty();
        PcValidator.Key(new PcKeyRequest("PRINT_SCREEN", null)).Should().ContainKey("key");
        PcValidator.Key(new PcKeyRequest("c", null)).Should().ContainKey("key");
        PcValidator.Key(new PcKeyRequest("C", ["CTRL", "CTRL"])).Should().ContainKey("modifiers");
        PcValidator.Key(new PcKeyRequest("C", ["META"])).Should().ContainKey("modifiers");
        PcValidator.Key(new PcKeyRequest("C", [null!])).Should().ContainKey("modifiers");
        PcValidator.Key(new PcKeyRequest("C", ["CTRL", "ALT", "SHIFT", "WIN", "CTRL"])).Should().ContainKey("modifiers");
    }

    [Theory]
    [InlineData("olá, mundo", true)]
    [InlineData("a", true)]
    [InlineData("", false)]
    [InlineData(null, false)]
    [InlineData("linha1\nlinha2", false)]
    [InlineData("tab\taqui", false)]
    [InlineData("controle\u0085c1", false)]
    public void Text_NeedsSomethingWithoutControlCharacters(string? text, bool valid) =>
        PcValidator.Text(new PcTextRequest(text)).Count.Should().Be(valid ? 0 : 1);

    [Fact]
    public void Text_CountsCharactersNotUtf16Units()
    {
        // 200 emojis são 400 unidades UTF-16, mas 200 caracteres: o contrato conta caracteres.
        PcValidator.Text(new PcTextRequest(string.Concat(Enumerable.Repeat("\U0001F600", 200)))).Should().BeEmpty();
        PcValidator.Text(new PcTextRequest(string.Concat(Enumerable.Repeat("\U0001F600", 201)))).Should().ContainKey("text");
        PcValidator.Text(new PcTextRequest(new string('x', 201))).Should().ContainKey("text");
    }

    [Fact]
    public void Media_LimitsTheStepsAndTheActions()
    {
        PcValidator.Media(new PcMediaRequest("VOLUME_UP", 10)).Should().BeEmpty();
        PcValidator.Media(new PcMediaRequest("MUTE", null)).Should().BeEmpty();
        PcValidator.Media(new PcMediaRequest("VOLUME_UP", 11)).Should().ContainKey("steps");
        PcValidator.Media(new PcMediaRequest("VOLUME_UP", 0)).Should().ContainKey("steps");
        PcValidator.Media(new PcMediaRequest("EJECT", null)).Should().ContainKey("action");
    }

    [Theory]
    [InlineData("LOCK", null, true)]
    [InlineData("LOCK", false, true)]
    [InlineData("CANCEL_SHUTDOWN", null, true)]
    [InlineData("SLEEP", null, false)]
    [InlineData("SLEEP", false, false)]
    [InlineData("SLEEP", true, true)]
    [InlineData("SHUTDOWN", null, false)]
    [InlineData("SHUTDOWN", false, false)]
    [InlineData("SHUTDOWN", true, true)]
    [InlineData("HIBERNATE", true, false)]
    [InlineData(null, true, false)]
    public void Power_AskingToSleepOrShutDownNeedsTheExplicitConfirmation(string? action, bool? confirm, bool valid) =>
        PcValidator.Power(new PcPowerRequest(action, confirm)).Count.Should().Be(valid ? 0 : 1);
}

public sealed class PcAppsStoreTests
{
    [Fact]
    public void KeepsTheListOfEachAgentSeparately_AndReplacesItWhole()
    {
        var store = new PcAppsStore();
        store.Get("pc-casa").Should().BeEmpty();
        store.Set("pc-casa", [new PcApp("navegador", "Navegador"), new PcApp("notas", "Notas")]);
        store.Set("outro", [new PcApp("jogo", "Jogo")]);

        store.Get("pc-casa").Select(a => a.Id).Should().Equal("navegador", "notas");
        store.Get("outro").Should().ContainSingle().Which.Id.Should().Be("jogo");

        store.Set("pc-casa", []);
        store.Get("pc-casa").Should().BeEmpty("a lista é sempre completa: vazia limpa os favoritos");
    }

    [Fact]
    public async Task TheAgentMessageHandler_StoresTheIdsAndNamesTheAgentSent()
    {
        var store = new PcAppsStore();
        var handler = new PcAgentMessageHandler(store);
        var body = JsonDocument.Parse(
            "{\"apps\":[{\"id\":\"navegador\",\"label\":\"Navegador\"},{\"id\":\"notas\",\"label\":\"Notas\"}],\"at\":\"2026-11-01T14:00:00Z\"}")
            .RootElement.Clone();

        handler.HandledTypes.Should().Equal(AgentMessageTypes.PcAppsV1);
        await handler.HandleAsync(
            new InboundMessage("pc-casa", Guid.CreateVersion7(), AgentMessageTypes.PcAppsV1, null, DateTimeOffset.UtcNow, body),
            TestContext.Current.CancellationToken);

        store.Get("pc-casa").Should().Equal(new PcApp("navegador", "Navegador"), new PcApp("notas", "Notas"));
    }
}
