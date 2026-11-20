using System.Text.Json;
using AwesomeAssertions;
using UniOver.BuildingBlocks.AgentProtocol;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Features.GetModuleInfo;
using UniOver.Modules.Devices.Features.PcControl;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;

namespace UniOver.Modules.Devices.Tests.PcControl;

public sealed class PcMessagesTests
{
    private static readonly AgentEnvelopeValidator Validator = new();

    /// <summary>Compara o JSON pelo conteúdo: a ordem das propriedades é a do gerador, não do contrato.</summary>
    private static void SameJson(JsonElement actual, string expected) =>
        System.Text.Json.Nodes.JsonNode.DeepEquals(System.Text.Json.Nodes.JsonNode.Parse(actual.GetRawText()), System.Text.Json.Nodes.JsonNode.Parse(expected))
            .Should().BeTrue($"o corpo devia ser {expected} e foi {actual.GetRawText()}");

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
            (PcMessages.PowerV2(PcPowerV2BodyAction.Restart), "pc.power.v2"),
            (PcMessages.PowerV2(PcPowerV2BodyAction.Logoff), "pc.power.v2"),
            (PcMessages.PowerV2(PcPowerV2BodyAction.Hibernate), "pc.power.v2"),
            (PcMessages.PowerV2(PcPowerV2BodyAction.MonitorOff), "pc.power.v2"),
            (PcMessages.AppLaunch("navegador"), "pc.app.launch.v1"),
            (PcMessages.MediaQuery(), "pc.media.query.v1"),
            (PcMessages.ClipboardQuery(), "pc.clipboard.query.v1"),
            (PcMessages.ClipboardSet("linha 1\r\nlinha 2\tfim"), "pc.clipboard.set.v1"),
        };

        foreach (var (message, type) in all)
        {
            message.Type.Should().Be(type);
            IsValidForTheContract(message).Should().BeTrue($"o corpo de {type} cumpre o esquema: {message.Body.GetRawText()}");
        }
    }

    [Fact]
    public void EveryMessageBuiltHere_IsDeliveredLive_NeverWaitingForTheAgentToReconnect()
    {
        OutboundMessage[] all =
        [
            PcMessages.Pointer(1, 1, 0, 0),
            PcMessages.Click(PcClickV1BodyButton.Left, PcClickV1BodyAction.Down),
            PcMessages.Key(PcKeyV1BodyKey.Enter, []),
            PcMessages.Text("olá"),
            PcMessages.Media(PcMediaV1BodyAction.VolumeUp, 1),
            PcMessages.Power(PcPowerV1BodyAction.Shutdown),
            PcMessages.PowerV2(PcPowerV2BodyAction.Restart),
            PcMessages.AppLaunch("navegador"),
            PcMessages.MediaQuery(),
            PcMessages.ClipboardQuery(),
            PcMessages.ClipboardSet("x"),
        ];

        all.Should().OnlyContain(m => m.Delivery == AgentDelivery.Immediate);
    }

    [Theory]
    [InlineData(PcPowerV2BodyAction.Restart, "pc.power.v2")]
    [InlineData(PcPowerV2BodyAction.Logoff, "pc.power.v2")]
    [InlineData(PcPowerV2BodyAction.MonitorOff, "pc.power.v2")]
    [InlineData(PcPowerV2BodyAction.Hibernate, "pc.power.hibernate.v1")]
    public void Hibernate_NeedsItsOwnCapability_TheOtherNewActionsTheV2(PcPowerV2BodyAction action, string capability) =>
        PcMessages.PowerV2CapabilityFor(action).Should().Be(capability);

    [Fact]
    public void TheApi_ListsTheNewCapabilities_SoTheAgentCanDeclareThem() =>
        GetModuleInfoHandler.AgentFeatures.Should().Contain(["pc.power.v2", "pc.power.hibernate.v1", "pc.media.state.v1", "pc.clipboard.v1"]);

    [Fact]
    public void TheMessagesThatReturnData_GoOnlyFromApiToAgent_AndTheirAnswersOnlyBack()
    {
        AgentMessageDirections.ToAgent.Should().Contain(["pc.media.query.v1", "pc.clipboard.query.v1", "pc.clipboard.set.v1"]);
        AgentMessageDirections.FromAgent.Should().Contain(["pc.media.state.v1", "pc.clipboard.v1"]);
        AgentMessageDirections.FromAgent.Should().NotContain(["pc.media.query.v1", "pc.clipboard.set.v1"]);
    }

    [Fact]
    public void AMessageThatDoesNotSayOtherwise_WaitsForTheReconnectionAsTheTvAlwaysDid() =>
        new OutboundMessage("tv.key.v1", JsonDocument.Parse("{}").RootElement.Clone()).Delivery
            .Should().Be(AgentDelivery.WaitForReconnect);

    [Fact]
    public void Pointer_LeavesOutTheScrollThatIsZero()
    {
        PcMessages.Pointer(3, -2, 0, 0).Body.GetRawText().Should().Be("{\"dx\":3,\"dy\":-2}");
        PcMessages.Pointer(0, 0, -240, 120).Body.GetRawText().Should().Be("{\"dx\":0,\"dy\":0,\"scrollX\":-240,\"scrollY\":120}");
    }

    /// <summary>
    /// O corpo do <c>pc.pointer.v1</c> como um agente anterior (0.44) o aceita: o esquema dele é FECHADO, então um campo a
    /// mais (como <c>seq</c>) faria o agente recusar a mensagem inteira e o touchpad ficaria morto até ele atualizar.
    /// </summary>
    private const string PointerBodySchemaOfAgent044 = """
        {"type":"object","additionalProperties":false,"required":["dx","dy"],"properties":{
          "dx":{"type":"integer","minimum":-2000,"maximum":2000},
          "dy":{"type":"integer","minimum":-2000,"maximum":2000},
          "scrollX":{"type":"integer","minimum":-1200,"maximum":1200},
          "scrollY":{"type":"integer","minimum":-1200,"maximum":1200}}}
        """;

    [Theory]
    [InlineData(3, -2, 0, 0)]
    [InlineData(0, 0, -240, 120)]
    [InlineData(2000, -2000, 1200, -1200)]
    public void Pointer_BodyIsAcceptedByTheClosedSchemaOfAnOlderAgent(int dx, int dy, int scrollX, int scrollY)
    {
        var schema = Json.Schema.JsonSchema.FromText(PointerBodySchemaOfAgent044);

        var body = PcMessages.Pointer(dx, dy, scrollX, scrollY).Body;

        schema.Evaluate(body).IsValid.Should().BeTrue();
        body.EnumerateObject().Select(p => p.Name).Should().NotContain("seq");
    }

    [Fact]
    public void Pointer_IsStillValidForTheCurrentContract() =>
        IsValidForTheContract(PcMessages.Pointer(12, -4, 0, 120)).Should().BeTrue();

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
        PcMessages.PowerV2Actions.Keys.Should().BeEquivalentTo(
            "LOCK", "SLEEP", "SHUTDOWN", "CANCEL_SHUTDOWN", "RESTART", "LOGOFF", "HIBERNATE", "MONITOR_OFF");
        // Só ficam sem confirmação o que não perde trabalho nem derruba a conexão: bloquear, cancelar e apagar o monitor.
        PcMessages.ConfirmedPowerActions.Should().BeEquivalentTo("SLEEP", "SHUTDOWN", "RESTART", "LOGOFF", "HIBERNATE");
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

    [Fact]
    public void KeyFitsV1_OnlyForV1KeysPressedOnce()
    {
        PcMessages.KeyFitsV1(new PcKeyRequest("C", ["CTRL"])).Should().BeTrue();
        PcMessages.KeyFitsV1(new PcKeyRequest("C", null, 1, "PRESS")).Should().BeTrue();
        PcMessages.KeyFitsV1(new PcKeyRequest("BACKSPACE", null, 2)).Should().BeFalse();
        PcMessages.KeyFitsV1(new PcKeyRequest("D1", null)).Should().BeFalse();
        PcMessages.KeyFitsV1(new PcKeyRequest("ALT", null, null, "DOWN")).Should().BeFalse();
    }

    [Fact]
    public void KeyFor_BuildsTheV1WhenTheRequestFitsAndTheV2OnlyWhenItNeedsIt()
    {
        var v1 = PcMessages.KeyFor(new PcKeyRequest("C", ["CTRL"], 1, "PRESS"));
        v1.Type.Should().Be(AgentMessageTypes.PcKeyV1);
        SameJson(v1.Body, "{\"key\":\"C\",\"modifiers\":[\"CTRL\"]}");
        IsValidForTheContract(v1).Should().BeTrue();

        var repeated = PcMessages.KeyFor(new PcKeyRequest("BACKSPACE", null, 12));
        repeated.Type.Should().Be(AgentMessageTypes.PcKeyV2);
        SameJson(repeated.Body, "{\"key\":\"BACKSPACE\",\"repeat\":12}");
        IsValidForTheContract(repeated).Should().BeTrue();

        var held = PcMessages.KeyFor(new PcKeyRequest("ALT", null, null, "DOWN"));
        held.Type.Should().Be(AgentMessageTypes.PcKeyV2);
        SameJson(held.Body, "{\"key\":\"ALT\",\"action\":\"DOWN\"}");
        IsValidForTheContract(held).Should().BeTrue();

        var digit = PcMessages.KeyFor(new PcKeyRequest("D0", ["CTRL"]));
        digit.Type.Should().Be(AgentMessageTypes.PcKeyV2);
        SameJson(digit.Body, "{\"key\":\"D0\",\"modifiers\":[\"CTRL\"]}");
        IsValidForTheContract(digit).Should().BeTrue();
    }

    [Fact]
    public void KeyV2Capability_IsTheOneTheHelloDeclares_AndTheApiListsItAsAFeature()
    {
        PcMessages.KeyV2Capability.Should().Be("pc.key.v2");
        GetModuleInfoHandler.AgentFeatures.Should().Contain("pc.key.v2");
    }

    [Fact]
    public void TextAndClickV2Capabilities_AreTheOnesTheHelloDeclares_AndTheApiListsThemAsFeatures()
    {
        PcMessages.TextV2Capability.Should().Be("pc.text.v2");
        PcMessages.ClickV2Capability.Should().Be("pc.click.v2");
        GetModuleInfoHandler.AgentFeatures.Should().Contain(["pc.text.v2", "pc.click.v2"]);
        AgentMessageDirections.ToAgent.Should().Contain([AgentMessageTypes.PcTextV2, AgentMessageTypes.PcClickV2]);
    }

    [Fact]
    public void ZoomAndVolumeCapabilities_AreTheOnesTheHelloDeclares_AndTheApiListsThemAsFeatures()
    {
        PcMessages.ZoomCapability.Should().Be("pc.pointer.zoom.v1");
        PcMessages.VolumeCapability.Should().Be("pc.volume.v1");
        GetModuleInfoHandler.AgentFeatures.Should().Contain(["pc.pointer.zoom.v1", "pc.volume.v1"]);
        AgentMessageDirections.ToAgent.Should().Contain([AgentMessageTypes.PcPointerZoomV1, AgentMessageTypes.PcVolumeV1]);
        AgentMessageDirections.FromAgent.Should().Contain(AgentMessageTypes.PcVolumeStateV1);
        AgentMessageDirections.FromAgent.Should().NotContain([AgentMessageTypes.PcPointerZoomV1, AgentMessageTypes.PcVolumeV1]);
    }

    [Fact]
    public void TargetCapability_IsTheOneTheHelloDeclares_AndTheApiListsItAsAFeature()
    {
        PcMessages.TargetCapability.Should().Be("pc.target.v1");
        GetModuleInfoHandler.AgentFeatures.Should().Contain("pc.target.v1");
        PcMessages.Targets.Should().BeEquivalentTo(["browser", "spotify", "vlc"]);
    }

    [Fact]
    public void WithTarget_AddsTheProgramToTheBody_AndTheKeyAndTextMessagesStillMeetTheContract()
    {
        var messages = new[]
        {
            PcMessages.KeyFor(new PcKeyRequest("W", ["CTRL"])),
            PcMessages.KeyFor(new PcKeyRequest("COMMA", ["SHIFT"])),
            PcMessages.TextFor(new PcTextRequest("+")),
            PcMessages.TextFor(new PcTextRequest("abc", Key: "ENTER")),
        };
        foreach (var message in messages)
        {
            var focused = PcMessages.WithTarget(message, "browser");
            focused.Body.GetProperty("target").GetString().Should().Be("browser");
            IsValidForTheContract(focused).Should().BeTrue($"{message.Type} com target cumpre o esquema: {focused.Body.GetRawText()}");
        }

        var outside = PcMessages.WithTarget(PcMessages.KeyFor(new PcKeyRequest("K", null)), "youtube");
        IsValidForTheContract(outside).Should().BeFalse("o contrato só conhece browser, spotify e vlc");
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData("browser", true)]
    [InlineData("spotify", true)]
    [InlineData("vlc", true)]
    [InlineData("youtube", false)]
    [InlineData("Browser", false)]
    [InlineData("", false)]
    public void KeyAndText_AcceptOnlyAKnownProgram(string? target, bool valid)
    {
        PcValidator.Key(new PcKeyRequest("K", null, Target: target)).ContainsKey("target").Should().Be(!valid);
        PcValidator.Text(new PcTextRequest("+", Target: target)).ContainsKey("target").Should().Be(!valid);
    }

    [Fact]
    public void Zoom_IsAMessageOfItsOwn_WithTheStepsAsTheContractSaysAndNothingElse()
    {
        var zoomIn = PcMessages.Zoom(3);
        zoomIn.Type.Should().Be(AgentMessageTypes.PcPointerZoomV1);
        SameJson(zoomIn.Body, "{\"steps\":3}");
        IsValidForTheContract(zoomIn).Should().BeTrue();

        var zoomOut = PcMessages.Zoom(-12);
        SameJson(zoomOut.Body, "{\"steps\":-12}");
        IsValidForTheContract(zoomOut).Should().BeTrue();
    }

    [Fact]
    public void Volume_CarriesOnlyWhatTheRequestHas()
    {
        var level = PcMessages.Volume(40, null);
        level.Type.Should().Be(AgentMessageTypes.PcVolumeV1);
        SameJson(level.Body, "{\"level\":40}");
        IsValidForTheContract(level).Should().BeTrue();

        var muted = PcMessages.Volume(null, true);
        SameJson(muted.Body, "{\"muted\":true}");
        IsValidForTheContract(muted).Should().BeTrue();

        var both = PcMessages.Volume(0, false);
        SameJson(both.Body, "{\"level\":0,\"muted\":false}");
        IsValidForTheContract(both).Should().BeTrue();
    }

    [Fact]
    public void WithSeq_NumbersTheZoomAndTheVolume_LikeEveryOtherInput()
    {
        const string page = "3fa9c10d7be2465a";
        var zoom = PcMessages.WithSeq(PcMessages.Zoom(2), 7, page);
        SameJson(zoom.Body, "{\"steps\":2,\"seq\":7,\"epoch\":\"3fa9c10d7be2465a\"}");
        IsValidForTheContract(zoom).Should().BeTrue();
        var volume = PcMessages.WithSeq(PcMessages.Volume(10, null), 8, page);
        SameJson(volume.Body, "{\"level\":10,\"seq\":8,\"epoch\":\"3fa9c10d7be2465a\"}");
        IsValidForTheContract(volume).Should().BeTrue();
    }

    [Fact]
    public void TextFitsV1_OnlyForPlainText()
    {
        PcMessages.TextFitsV1(new PcTextRequest("olá")).Should().BeTrue();
        PcMessages.TextFitsV1(new PcTextRequest("olá", null, null, 0, null)).Should().BeTrue();
        PcMessages.TextFitsV1(new PcTextRequest("olá", null, null, 2, null)).Should().BeFalse();
        PcMessages.TextFitsV1(new PcTextRequest("olá", null, null, null, "ENTER")).Should().BeFalse();
        PcMessages.TextFitsV1(new PcTextRequest(null, null, null, 2, null)).Should().BeFalse();
    }

    [Fact]
    public void TextFor_BuildsTheV1ForPlainTextAndTheV2OnlyWhenItNeedsIt()
    {
        var plain = PcMessages.TextFor(new PcTextRequest("olá", null, null, 0, null));
        plain.Type.Should().Be(AgentMessageTypes.PcTextV1);
        SameJson(plain.Body, "{\"text\":\"olá\"}");
        IsValidForTheContract(plain).Should().BeTrue();

        var edit = PcMessages.TextFor(new PcTextRequest("olá", null, null, 3, "ENTER"));
        edit.Type.Should().Be(AgentMessageTypes.PcTextV2);
        SameJson(edit.Body, "{\"erase\":3,\"text\":\"olá\",\"key\":\"ENTER\"}");
        IsValidForTheContract(edit).Should().BeTrue();

        var eraseOnly = PcMessages.TextFor(new PcTextRequest(null, null, null, 5, null));
        SameJson(eraseOnly.Body, "{\"erase\":5}");
        IsValidForTheContract(eraseOnly).Should().BeTrue();

        var keyOnly = PcMessages.TextFor(new PcTextRequest("", null, null, null, "TAB"));
        SameJson(keyOnly.Body, "{\"key\":\"TAB\"}");
        IsValidForTheContract(keyOnly).Should().BeTrue();
    }

    [Fact]
    public void TextFor_TakesLinesAndTabsInsideTheTextOnlyThroughTheV3()
    {
        // O texto colado com várias linhas vai inteiro: a quebra de linha e a tabulação ficam no texto, em ordem.
        var pasted = new PcTextRequest("- item 1\n\tdetalhe\n- item 2", null, null, 2, "ENTER");
        PcMessages.TextFitsV1(pasted).Should().BeFalse();
        PcMessages.TextCapability(pasted).Should().Be(PcMessages.TextV3Capability);
        var message = PcMessages.TextFor(pasted);
        message.Type.Should().Be(AgentMessageTypes.PcTextV3);
        SameJson(message.Body, "{\"erase\":2,\"text\":\"- item 1\\n\\tdetalhe\\n- item 2\",\"key\":\"ENTER\"}");
        IsValidForTheContract(message).Should().BeTrue();
        // Cada quebra e tabulação vira uma tecla no PC: conta no limite de teclas como o apagar e a tecla do fim.
        PcMessages.TextPresses(pasted).Should().Be(2 + 1 + 3);

        // Sem quebra de linha nada muda: a v1 para o texto puro e a v2 para apagar ou apertar a tecla do fim.
        PcMessages.TextCapability(new PcTextRequest("olá")).Should().BeNull();
        PcMessages.TextCapability(new PcTextRequest("olá", null, null, 1, null)).Should().Be(PcMessages.TextV2Capability);
        PcMessages.TextFor(new PcTextRequest("a\tb")).Type.Should().Be(AgentMessageTypes.PcTextV3);
        PcMessages.TextV3Capability.Should().Be("pc.text.v3");
        GetModuleInfoHandler.AgentFeatures.Should().Contain("pc.text.v3");
        AgentMessageDirections.ToAgent.Should().Contain(AgentMessageTypes.PcTextV3);
    }

    [Fact]
    public void TextPresses_CountsEveryBackspaceAndTheKeyAtTheEnd()
    {
        PcMessages.TextPresses(new PcTextRequest("abc")).Should().Be(0);
        PcMessages.TextPresses(new PcTextRequest("abc", null, null, 4, null)).Should().Be(4);
        PcMessages.TextPresses(new PcTextRequest("abc", null, null, 4, "ENTER")).Should().Be(5);
        PcMessages.TextPresses(new PcTextRequest(null, null, null, null, "TAB")).Should().Be(1);
    }

    [Fact]
    public void ClickFitsV1_OnlyWithoutModifiersAndWithoutAGap()
    {
        PcMessages.ClickFitsV1(new PcClickRequest("LEFT", null)).Should().BeTrue();
        PcMessages.ClickFitsV1(new PcClickRequest("LEFT", "DOUBLE", null, null, [], 0)).Should().BeTrue();
        PcMessages.ClickFitsV1(new PcClickRequest("LEFT", null, null, null, ["CTRL"], null)).Should().BeFalse();
        PcMessages.ClickFitsV1(new PcClickRequest("LEFT", null, null, null, null, 120)).Should().BeFalse();
    }

    [Fact]
    public void ClickFor_BuildsTheV1WhenTheRequestFitsAndTheV2OnlyWhenItNeedsIt()
    {
        var plain = PcMessages.ClickFor(new PcClickRequest("RIGHT", "DOUBLE"));
        plain.Type.Should().Be(AgentMessageTypes.PcClickV1);
        SameJson(plain.Body, "{\"button\":\"RIGHT\",\"action\":\"DOUBLE\"}");
        IsValidForTheContract(plain).Should().BeTrue();

        var withModifiers = PcMessages.ClickFor(new PcClickRequest("LEFT", null, null, null, ["CTRL", "SHIFT"], null));
        withModifiers.Type.Should().Be(AgentMessageTypes.PcClickV2);
        SameJson(withModifiers.Body, "{\"button\":\"LEFT\",\"modifiers\":[\"CTRL\",\"SHIFT\"]}");
        IsValidForTheContract(withModifiers).Should().BeTrue();

        var withGap = PcMessages.ClickFor(new PcClickRequest("LEFT", "CLICK", null, null, null, 140));
        withGap.Type.Should().Be(AgentMessageTypes.PcClickV2);
        SameJson(withGap.Body, "{\"button\":\"LEFT\",\"gapMs\":140}");
        IsValidForTheContract(withGap).Should().BeTrue();

        var both = PcMessages.ClickFor(new PcClickRequest("MIDDLE", "DOUBLE", null, null, ["ALT"], 90));
        SameJson(both.Body, "{\"button\":\"MIDDLE\",\"action\":\"DOUBLE\",\"modifiers\":[\"ALT\"],\"gapMs\":90}");
        IsValidForTheContract(both).Should().BeTrue();
    }

    [Fact]
    public void TheV2BodiesCarryTheSequenceAndEpochTheDirectChannelNeeds()
    {
        const string page = "3fa9c10d7be2465a";
        var text = PcMessages.WithSeq(PcMessages.TextFor(new PcTextRequest("a", null, null, 2, null)), 7, page);
        var click = PcMessages.WithSeq(PcMessages.ClickFor(new PcClickRequest("LEFT", null, null, null, ["CTRL"], null)), 8, page);

        SameJson(text.Body, "{\"erase\":2,\"text\":\"a\",\"seq\":7,\"epoch\":\"3fa9c10d7be2465a\"}");
        SameJson(click.Body, "{\"button\":\"LEFT\",\"modifiers\":[\"CTRL\"],\"seq\":8,\"epoch\":\"3fa9c10d7be2465a\"}");
        IsValidForTheContract(text).Should().BeTrue("o esquema fechado da v2 aceita o número e a época");
        IsValidForTheContract(click).Should().BeTrue("o esquema fechado da v2 aceita o número e a época");
    }
}

public sealed class PcProblemsTests
{
    [Fact]
    public void NoLiveSession_IsAnswered503Reconnecting_BecauseTheHandlerOnlyGetsHereWithThePcShownAsConnected()
    {
        var result = (ProblemHttpResult)PcProblems.FromGateway(AgentErrors.Offline);

        result.StatusCode.Should().Be(StatusCodes.Status503ServiceUnavailable);
        result.ProblemDetails.Type.Should().EndWith("/agent-reconnecting");
        result.ProblemDetails.Title.Should().Be("O PC está reconectando. Tente de novo em instantes.");
    }

    [Fact]
    public void OtherGatewayFailures_KeepTheirOwnAnswers()
    {
        var timeout = (ProblemHttpResult)PcProblems.FromGateway(AgentErrors.Timeout);
        var invalid = (ProblemHttpResult)PcProblems.FromGateway(AgentErrors.InvalidMessage("x"));

        timeout.StatusCode.Should().Be(StatusCodes.Status504GatewayTimeout);
        timeout.ProblemDetails.Type.Should().EndWith("/agent-timeout");
        invalid.StatusCode.Should().Be(StatusCodes.Status500InternalServerError);
    }
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
    public void Pointer_AcceptsAnOptionalSequenceThatIsNotNegative()
    {
        PcValidator.Pointer(new PcPointerRequest(1, 1, null, null, 0)).Should().BeEmpty();
        PcValidator.Pointer(new PcPointerRequest(1, 1, null, null, int.MaxValue)).Should().BeEmpty();
        PcValidator.Pointer(new PcPointerRequest(1, 1, null, null, null)).Should().BeEmpty();
        PcValidator.Pointer(new PcPointerRequest(1, 1, null, null, -1)).Should().ContainKey("seq");
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
        PcValidator.Key(new PcKeyRequest("F13", null)).Should().ContainKey("key");
        PcValidator.Key(new PcKeyRequest("c", null)).Should().ContainKey("key");
        PcValidator.Key(new PcKeyRequest("C", ["CTRL", "CTRL"])).Should().ContainKey("modifiers");
        PcValidator.Key(new PcKeyRequest("C", ["META"])).Should().ContainKey("modifiers");
        PcValidator.Key(new PcKeyRequest("C", [null!])).Should().ContainKey("modifiers");
        PcValidator.Key(new PcKeyRequest("C", ["CTRL", "ALT", "SHIFT", "WIN", "CTRL"])).Should().ContainKey("modifiers");
    }

    [Theory]
    [InlineData("D0")]
    [InlineData("D9")]
    [InlineData("MINUS")]
    [InlineData("EQUALS")]
    [InlineData("COMMA")]
    [InlineData("PERIOD")]
    [InlineData("INSERT")]
    [InlineData("PRINT_SCREEN")]
    [InlineData("APPS")]
    [InlineData("WIN")]
    [InlineData("CAPS_LOCK")]
    public void Key_AcceptsTheKeysOnlyTheV2Has(string key) =>
        PcValidator.Key(new PcKeyRequest(key, null)).Should().BeEmpty();

    [Fact]
    public void Key_RepeatIsBetweenOneAndFifty()
    {
        PcValidator.Key(new PcKeyRequest("BACKSPACE", null, 1)).Should().BeEmpty();
        PcValidator.Key(new PcKeyRequest("BACKSPACE", null, 50)).Should().BeEmpty();
        PcValidator.Key(new PcKeyRequest("BACKSPACE", null, 0)).Should().ContainKey("repeat");
        PcValidator.Key(new PcKeyRequest("BACKSPACE", null, 51)).Should().ContainKey("repeat");
        PcValidator.Key(new PcKeyRequest("BACKSPACE", null, -3)).Should().ContainKey("repeat");
    }

    [Fact]
    public void Key_HoldingAndReleasingOnlyWorksForAloneModifiers()
    {
        PcValidator.Key(new PcKeyRequest("ALT", null, null, "DOWN")).Should().BeEmpty();
        PcValidator.Key(new PcKeyRequest("WIN", null, null, "UP")).Should().BeEmpty();
        PcValidator.Key(new PcKeyRequest("ALT", null, null, "PRESS")).Should().BeEmpty();
        PcValidator.Key(new PcKeyRequest("ALT", null, null, "HOLD")).Should().ContainKey("action");
        PcValidator.Key(new PcKeyRequest("A", null, null, "DOWN")).Should().ContainKey("action");
        PcValidator.Key(new PcKeyRequest("TAB", null, null, "UP")).Should().ContainKey("action");
        PcValidator.Key(new PcKeyRequest("ALT", ["SHIFT"], null, "DOWN")).Should().ContainKey("modifiers");
        PcValidator.Key(new PcKeyRequest("ALT", null, 3, "DOWN")).Should().ContainKey("repeat");
    }

    [Theory]
    [InlineData("olá, mundo", true)]
    [InlineData("a", true)]
    [InlineData("", false)]
    [InlineData(null, false)]
    [InlineData("linha1\nlinha2", true)]
    [InlineData("tab\taqui", true)]
    [InlineData("linha1\r\nlinha2", false)]
    [InlineData("controle\u0085c1", false)]
    [InlineData("sino\u0007", false)]
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
    public void Click_ModifiersAndGapFollowTheContractOfTheV2()
    {
        PcValidator.Click(new PcClickRequest("LEFT", null, null, null, ["CTRL", "SHIFT"], 120)).Should().BeEmpty();
        PcValidator.Click(new PcClickRequest("LEFT", "DOUBLE", null, null, ["ALT"], 0)).Should().BeEmpty();
        PcValidator.Click(new PcClickRequest("LEFT", null, null, null, ["CTRL", "CTRL"], null)).Should().ContainKey("modifiers");
        PcValidator.Click(new PcClickRequest("LEFT", null, null, null, ["META"], null)).Should().ContainKey("modifiers");
        PcValidator.Click(new PcClickRequest("LEFT", null, null, null, ["WIN"], null)).Should().ContainKey("modifiers");
        PcValidator.Click(new PcClickRequest("LEFT", null, null, null, ["CTRL", "ALT", "SHIFT"], null)).Should().BeEmpty();
        PcValidator.Click(new PcClickRequest("LEFT", null, null, null, ["CTRL", "ALT", "SHIFT", "CTRL"], null)).Should().ContainKey("modifiers");
        PcValidator.MaxClickModifiers.Should().Be(3);
        PcValidator.Click(new PcClickRequest("LEFT", null, null, null, ["CTRL", "ALT", "SHIFT", "WIN", "CTRL"], null)).Should().ContainKey("modifiers");
        PcValidator.Click(new PcClickRequest("LEFT", null, null, null, null, 400)).Should().BeEmpty();
        PcValidator.Click(new PcClickRequest("LEFT", null, null, null, null, 401)).Should().ContainKey("gapMs");
        PcValidator.Click(new PcClickRequest("LEFT", null, null, null, null, -1)).Should().ContainKey("gapMs");
    }

    [Theory]
    [InlineData("DOWN")]
    [InlineData("UP")]
    public void Click_HoldingTheButtonNeverTakesAModifierOrAGap(string action)
    {
        PcValidator.Click(new PcClickRequest("LEFT", action, null, null, ["CTRL"], null)).Should().ContainKey("action");
        PcValidator.Click(new PcClickRequest("LEFT", action, null, null, null, 100)).Should().ContainKey("action");
        PcValidator.Click(new PcClickRequest("LEFT", action, null, null, null, 0)).Should().BeEmpty();
        PcValidator.Click(new PcClickRequest("LEFT", action)).Should().BeEmpty();
    }

    [Fact]
    public void Text_V2CanEraseAndPressAKeyWithoutText()
    {
        PcValidator.Text(new PcTextRequest(null, null, null, 3, null)).Should().BeEmpty();
        PcValidator.Text(new PcTextRequest("", null, null, null, "ENTER")).Should().BeEmpty();
        PcValidator.Text(new PcTextRequest("abc", null, null, 200, "TAB")).Should().BeEmpty();
        PcValidator.Text(new PcTextRequest(null, null, null, 0, null)).Should().ContainKey("text");
        PcValidator.Text(new PcTextRequest(null, null, null, 201, null)).Should().ContainKey("erase");
        PcValidator.Text(new PcTextRequest("a", null, null, -1, null)).Should().ContainKey("erase");
        PcValidator.Text(new PcTextRequest("a", null, null, null, "ESCAPE")).Should().ContainKey("key");
        PcValidator.Text(new PcTextRequest("a\nb", null, null, 1, "ENTER")).Should().BeEmpty();
        PcValidator.Text(new PcTextRequest("a\rb", null, null, 1, "ENTER")).Should().ContainKey("text");
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
    [InlineData("HIBERNATE", null, false)]
    [InlineData("HIBERNATE", true, true)]
    [InlineData("RESTART", null, false)]
    [InlineData("RESTART", false, false)]
    [InlineData("RESTART", true, true)]
    [InlineData("LOGOFF", null, false)]
    [InlineData("LOGOFF", true, true)]
    [InlineData("MONITOR_OFF", null, true)]
    [InlineData("REBOOT", true, false)]
    [InlineData("restart", true, false)]
    [InlineData(null, true, false)]
    public void Power_AskingToSleepOrShutDownNeedsTheExplicitConfirmation(string? action, bool? confirm, bool valid) =>
        PcValidator.Power(new PcPowerRequest(action, confirm)).Count.Should().Be(valid ? 0 : 1);

    [Theory]
    [InlineData("olá, mundo", true)]
    [InlineData("linha 1\r\nlinha 2\tfim", true)]
    [InlineData("", false)]
    [InlineData(null, false)]
    [InlineData("a\u0000b", false)]
    [InlineData("a\u001bb", false)]
    [InlineData("a\u007fb", false)]
    public void Clipboard_AcceptsTextWithTabsAndLineBreaks_ButNoOtherControlCharacter(string? text, bool valid) =>
        PcValidator.Clipboard(new PcClipboardWriteRequest(text)).Count.Should().Be(valid ? 0 : 1);

    [Fact]
    public void Clipboard_AcceptsUpToTheContractLimit()
    {
        PcValidator.Clipboard(new PcClipboardWriteRequest(new string('x', PcValidator.MaxClipboardLength))).Should().BeEmpty();
        PcValidator.Clipboard(new PcClipboardWriteRequest(new string('x', PcValidator.MaxClipboardLength + 1))).Should().ContainKey("text");
        PcValidator.Clipboard(null).Should().ContainKey("text");
    }
}

public sealed class PcMediaAndClipboardStoreTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 14, 12, 0, 0, TimeSpan.Zero);

    private static AgentPresenceInfo Presence(string slug, bool connected, DateTimeOffset? helloAt) =>
        new(slug, connected, DateTimeOffset.UnixEpoch, "0.1.0", [], null, null, null, null, helloAt);

    private static PcAgentMessageHandler Handler(PcMediaStates media, PcClipboardInbox clipboard) =>
        new(
            new PcAppsStore(),
            new PcRtcAnswers(TimeProvider.System),
            new PcRtcClosures(new PcRtcSessions(TimeProvider.System), null!, null!, null!),
            new PcVolumeStore(),
            new PcDeviceStates(TimeProvider.System),
            media: media,
            clipboard: clipboard);

    private static InboundMessage Message(string type, string body, Guid? correlationId = null) =>
        new("pc-casa", Guid.CreateVersion7(), type, correlationId, T0, JsonDocument.Parse(body).RootElement.Clone());

    [Fact]
    public async Task TheAgentMessageHandler_KeepsWhatThePcSaysIsPlaying()
    {
        var media = new PcMediaStates();
        var handler = Handler(media, new PcClipboardInbox(TimeProvider.System));

        handler.HandledTypes.Should().Contain([AgentMessageTypes.PcMediaStateV1, AgentMessageTypes.PcClipboardV1]);
        await handler.HandleAsync(
            Message(
                AgentMessageTypes.PcMediaStateV1,
                "{\"status\":\"paused\",\"title\":\"Águas de Março\",\"artist\":\"Elis\",\"app\":\"Spotify.exe\",\"at\":\"2026-11-14T12:00:00Z\"}"),
            TestContext.Current.CancellationToken);

        media.Get("pc-casa").Should().Be(new PcNowPlaying("paused", "Águas de Março", "Elis", "Spotify.exe", T0));
        media.Get("outro").Should().BeNull();
    }

    [Fact]
    public void WhatWasPlaying_IsDropped_WhenTheAgentDropsOrStartsANewConnection()
    {
        var media = new PcMediaStates();
        media.Set("pc-casa", new PcNowPlaying("playing", "t", "a", "app", T0));
        media.OnPresenceChanged(Presence("pc-casa", true, T0));
        media.Get("pc-casa").Should().NotBeNull();
        media.OnPresenceChanged(Presence("pc-casa", false, T0));
        media.Get("pc-casa").Should().BeNull();
    }

    [Fact]
    public async Task TheClipboardText_IsHandedOnlyToTheRequestThatReadIt_AndOnlyOnce()
    {
        var clipboard = new PcClipboardInbox(TimeProvider.System);
        var handler = Handler(new PcMediaStates(), clipboard);
        var mine = Guid.CreateVersion7();
        var other = Guid.CreateVersion7();
        using var pending = clipboard.Expect("pc-casa", mine, TestContext.Current.CancellationToken);

        await handler.HandleAsync(
            Message(AgentMessageTypes.PcClipboardV1, "{\"text\":\"senha\",\"at\":\"2026-11-14T12:00:00Z\"}", mine),
            TestContext.Current.CancellationToken);

        clipboard.Take("pc-casa", other).Should().BeNull("o texto é de outro pedido");
        clipboard.Take("outro", mine).Should().BeNull("o texto é de outro agente");
        clipboard.Take("pc-casa", mine).Should().Be("senha");
        clipboard.Take("pc-casa", mine).Should().BeNull("entregue uma vez só");
    }

    [Fact]
    public async Task AClipboardTextWithNoRequest_IsDiscarded()
    {
        var clipboard = new PcClipboardInbox(TimeProvider.System);
        await Handler(new PcMediaStates(), clipboard).HandleAsync(
            Message(AgentMessageTypes.PcClipboardV1, "{\"text\":\"senha\",\"at\":\"2026-11-14T12:00:00Z\"}"),
            TestContext.Current.CancellationToken);

        clipboard.Count.Should().Be(0);
    }

    [Fact]
    public void AClipboardTextThatWaitedTooLong_CannotBeTaken()
    {
        var time = new FakeTimeProvider(T0);
        var clipboard = new PcClipboardInbox(time);
        var first = Guid.CreateVersion7();
        using var pending = clipboard.Expect("pc-casa", first, TestContext.Current.CancellationToken);
        clipboard.Set("pc-casa", first, "velho");

        time.Advance(PcClipboardInbox.Lifetime + TimeSpan.FromSeconds(1));
        clipboard.Take("pc-casa", first).Should().BeNull();
    }

    [Fact]
    public void ClipboardText_ExpiresWithoutAnyFurtherActivity()
    {
        var time = new FakeTimeProvider(T0);
        var clipboard = new PcClipboardInbox(time);
        var request = Guid.CreateVersion7();
        using var pending = clipboard.Expect("pc-casa", request, TestContext.Current.CancellationToken);
        clipboard.Set("pc-casa", request, "texto temporário");

        time.Advance(PcClipboardInbox.Lifetime);

        clipboard.Count.Should().Be(0);
    }

    [Fact]
    public void ClipboardText_IsForgottenOnCancellation_AndLateDataIsDiscarded()
    {
        var clipboard = new PcClipboardInbox(TimeProvider.System);
        using var cancelled = new CancellationTokenSource();
        var received = Guid.CreateVersion7();
        var awaiting = Guid.CreateVersion7();
        using var receivedRead = clipboard.Expect("pc-casa", received, cancelled.Token);
        using var awaitingRead = clipboard.Expect("pc-casa", awaiting, cancelled.Token);
        clipboard.Set("pc-casa", received, "já chegou");
        clipboard.Count.Should().Be(1);

        cancelled.Cancel();
        clipboard.Set("pc-casa", awaiting, "chegou depois");

        clipboard.Count.Should().Be(0);
    }

    [Fact]
    public void TheClipboardTexts_AreDropped_WhenTheAgentDrops()
    {
        var clipboard = new PcClipboardInbox(TimeProvider.System);
        var first = Guid.CreateVersion7();
        var second = Guid.CreateVersion7();
        using var firstRead = clipboard.Expect("pc-casa", first, TestContext.Current.CancellationToken);
        using var secondRead = clipboard.Expect("outro", second, TestContext.Current.CancellationToken);
        clipboard.Set("pc-casa", first, "a");
        clipboard.Set("outro", second, "b");

        clipboard.OnPresenceChanged(Presence("pc-casa", false, T0));

        clipboard.Count.Should().Be(1, "só os textos do agente que caiu");
    }
}

public sealed class PcZoomAndVolumeValidatorTests
{
    [Theory]
    [InlineData(1, true)]
    [InlineData(-1, true)]
    [InlineData(12, true)]
    [InlineData(-12, true)]
    [InlineData(0, false)]
    [InlineData(13, false)]
    [InlineData(-13, false)]
    public void Zoom_AcceptsTwelveStepsEitherWay_ButNeverZero(int steps, bool valid) =>
        PcValidator.Zoom(new PcZoomRequest(steps)).Count.Should().Be(valid ? 0 : 1);

    [Fact]
    public void Zoom_NeedsTheSteps_AndChecksTheNumbering()
    {
        PcValidator.Zoom(new PcZoomRequest(null)).Should().ContainKey("steps");
        PcValidator.Zoom(null).Should().ContainKey("steps");
        PcValidator.Zoom(new PcZoomRequest(2, -1)).Should().ContainKey("seq");
        PcValidator.Zoom(new PcZoomRequest(2, 5, "XYZ")).Should().ContainKey("epoch");
        PcValidator.Zoom(new PcZoomRequest(2, 5, "3fa9c10d7be2465a")).Should().BeEmpty();
    }

    [Theory]
    [InlineData(0, null, true)]
    [InlineData(100, null, true)]
    [InlineData(37, true, true)]
    [InlineData(null, false, true)]
    [InlineData(null, null, false)]
    [InlineData(101, null, false)]
    [InlineData(-1, true, false)]
    public void Volume_AcceptsALevelFromZeroToOneHundredAndOrTheMute_ButNotNothing(int? level, bool? muted, bool valid) =>
        PcValidator.Volume(new PcVolumeRequest(level, muted)).Count.Should().Be(valid ? 0 : 1);

    [Fact]
    public void Volume_NullRequestIsRefused_AndTheNumberingIsChecked()
    {
        PcValidator.Volume(null).Should().ContainKey("level");
        PcValidator.Volume(new PcVolumeRequest(10, null, -1)).Should().ContainKey("seq");
        PcValidator.Volume(new PcVolumeRequest(10, null, 1, "ZZ")).Should().ContainKey("epoch");
    }
}

public sealed class PcVolumeStoreTests
{
    [Fact]
    public void KeepsTheLastVolumeOfEachAgentSeparately()
    {
        var store = new PcVolumeStore();
        store.Get("pc-casa").Should().BeNull();
        store.Set("pc-casa", new PcVolumeState(40, false));
        store.Set("outro", new PcVolumeState(10, true));
        store.Set("pc-casa", new PcVolumeState(55, true));

        store.Get("pc-casa").Should().Be(new PcVolumeState(55, true));
        store.Get("outro").Should().Be(new PcVolumeState(10, true));
    }

    private static AgentPresenceInfo Presence(string slug, bool connected, DateTimeOffset? helloAt) =>
        new(slug, connected, DateTimeOffset.UnixEpoch, "0.1.0", [], null, null, null, null, helloAt);

    [Fact]
    public void ALevelFromAnEarlierSessionIsDropped_WhenTheAgentDropsOrStartsANewConnection()
    {
        var store = new PcVolumeStore();
        store.Set("pc-casa", new PcVolumeState(20, false));
        store.Set("outro", new PcVolumeState(70, false));

        // Mensagens de presença de uma sessão com hello não mexem em nada (nem as de outro agente).
        store.OnPresenceChanged(Presence("pc-casa", true, DateTimeOffset.UnixEpoch));
        store.Get("pc-casa").Should().Be(new PcVolumeState(20, false));

        // Queda: o nível se vai.
        store.OnPresenceChanged(Presence("pc-casa", false, DateTimeOffset.UnixEpoch));
        store.Get("pc-casa").Should().BeNull();
        store.Get("outro").Should().Be(new PcVolumeState(70, false));

        // Volta (conexão nova, ainda sem hello): o que chegar depois é da sessão nova e vale.
        store.Set("pc-casa", new PcVolumeState(30, false));
        store.OnPresenceChanged(Presence("pc-casa", true, null));
        store.Get("pc-casa").Should().BeNull("o 30 era da sessão anterior à conexão nova");
        store.Set("pc-casa", new PcVolumeState(80, false));
        store.Get("pc-casa").Should().Be(new PcVolumeState(80, false));
    }

    [Fact]
    public async Task TheAgentMessageHandler_StoresTheVolumeTheAgentSent()
    {
        var volume = new PcVolumeStore();
        var handler = new PcAgentMessageHandler(
            new PcAppsStore(),
            new PcRtcAnswers(TimeProvider.System),
            new PcRtcClosures(new PcRtcSessions(TimeProvider.System), null!, null!, null!),
            volume,
            new PcDeviceStates(TimeProvider.System));
        var body = JsonDocument.Parse("{\"level\":62,\"muted\":true,\"at\":\"2026-11-09T14:00:00Z\"}").RootElement.Clone();

        handler.HandledTypes.Should().Contain(AgentMessageTypes.PcVolumeStateV1);
        await handler.HandleAsync(
            new InboundMessage("pc-casa", Guid.CreateVersion7(), AgentMessageTypes.PcVolumeStateV1, null, DateTimeOffset.UtcNow, body),
            TestContext.Current.CancellationToken);

        volume.Get("pc-casa").Should().Be(new PcVolumeState(62, true));
    }
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
        var handler = new PcAgentMessageHandler(store, new PcRtcAnswers(TimeProvider.System), new PcRtcClosures(new PcRtcSessions(TimeProvider.System), null!, null!, null!), new PcVolumeStore(), new PcDeviceStates(TimeProvider.System));
        var body = JsonDocument.Parse(
            "{\"apps\":[{\"id\":\"navegador\",\"label\":\"Navegador\"},{\"id\":\"notas\",\"label\":\"Notas\"}],\"at\":\"2026-11-01T14:00:00Z\"}")
            .RootElement.Clone();

        handler.HandledTypes.Should().Contain(AgentMessageTypes.PcAppsV1);
        await handler.HandleAsync(
            new InboundMessage("pc-casa", Guid.CreateVersion7(), AgentMessageTypes.PcAppsV1, null, DateTimeOffset.UtcNow, body),
            TestContext.Current.CancellationToken);

        store.Get("pc-casa").Should().Equal(new PcApp("navegador", "Navegador"), new PcApp("notas", "Notas"));
    }
}

public sealed class PcTargetCacheTests
{
    private static readonly Guid Alice = Guid.Parse("22222222-2222-7222-8222-222222222222");

    private static PcAgentRow Row(string slug) => new(Guid.CreateVersion7(), slug, Alice, DateTimeOffset.UnixEpoch);

    [Fact]
    public void KeepsTheRowsOnlyForAFewSeconds()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UnixEpoch);
        var cache = new PcTargetCache(time);
        cache.Set(Alice, [Row("pc-alice")]);

        time.Advance(PcTargetCache.Lifetime - TimeSpan.FromMilliseconds(1));
        cache.TryGet(Alice, out var rows).Should().BeTrue();
        rows.Should().ContainSingle().Which.Slug.Should().Be("pc-alice");

        time.Advance(TimeSpan.FromMilliseconds(1));
        cache.TryGet(Alice, out _).Should().BeFalse();
    }

    [Fact]
    public void NeverKeepsAnEmptyList_SoANewlyPairedPcShowsUpAtOnce()
    {
        var cache = new PcTargetCache(new FakeTimeProvider(DateTimeOffset.UnixEpoch));
        cache.Set(Alice, []);
        cache.TryGet(Alice, out _).Should().BeFalse();
    }

    [Fact]
    public async Task ARevokedAgentMakesTheNextRequestReadTheDatabase()
    {
        var cache = new PcTargetCache(new FakeTimeProvider(DateTimeOffset.UnixEpoch));
        cache.Set(Alice, [Row("pc-alice")]);

        await new PcAgentRevokedInvalidator(cache).HandleAsync(
            new UniOver.Modules.Devices.Contracts.Pairing.AgentRevoked(Guid.CreateVersion7(), DateTimeOffset.UtcNow, Guid.CreateVersion7(), "pc-alice"),
            TestContext.Current.CancellationToken);

        cache.TryGet(Alice, out _).Should().BeFalse();
    }
}

public sealed class PcAgentResolverTests
{
    private static readonly Guid Owner = Guid.Parse("11111111-1111-7111-8111-111111111111");
    private static readonly Guid Alice = Guid.Parse("22222222-2222-7222-8222-222222222222");
    private static readonly Guid Bruno = Guid.Parse("33333333-3333-7333-8333-333333333333");
    private static readonly DateTimeOffset T0 = new(2026, 11, 1, 12, 0, 0, TimeSpan.Zero);

    private static PcCandidate Pc(string slug, Guid pairedBy, bool connected, int ageMinutes = 0) =>
        new(Guid.CreateVersion7(), slug, pairedBy, T0.AddMinutes(ageMinutes), connected, ["pc.control.v1"]);

    [Fact]
    public void APersonOnlyDrivesThePcsSheHerselfPaired()
    {
        var all = new[] { Pc("pc-casa", Owner, true), Pc("pc-alice", Alice, true), Pc("pc-bruno", Bruno, true) };

        PcAgentResolver.Choose(all, Alice)!.Slug.Should().Be("pc-alice");
        PcAgentResolver.Choose(all, Bruno)!.Slug.Should().Be("pc-bruno");
        PcAgentResolver.Choose(all, Owner)!.Slug.Should().Be("pc-casa");
    }

    [Fact]
    public void WithoutAPcOfHerOwn_ThereIsNoFallback_NotTheHouseOneNorAnotherGuests()
    {
        var all = new[] { Pc("pc-casa", Owner, true), Pc("pc-bruno", Bruno, true) };

        PcAgentResolver.Choose(all, Alice).Should().BeNull();
        PcAgentResolver.Choose([], Alice).Should().BeNull();
    }

    [Fact]
    public void TheOwnerDoesNotReachAGuestsPcEither() =>
        PcAgentResolver.Choose([Pc("pc-alice", Alice, true)], Owner).Should().BeNull();

    [Fact]
    public void WhenHerOwnPcIsOff_TheAnswerIsHerPcOffline_NeverAnotherPersonsPcOn()
    {
        var all = new[] { Pc("pc-alice", Alice, false), Pc("pc-casa", Owner, true) };

        var target = PcAgentResolver.Choose(all, Alice)!;

        target.Slug.Should().Be("pc-alice");
        target.Connected.Should().BeFalse();
    }

    [Fact]
    public void AmongSeveralOfHerOwn_TheConnectedOneWinsAndThenTheOldest()
    {
        var all = new[]
        {
            Pc("velho-desligado", Alice, false, 0),
            Pc("novo-ligado", Alice, true, 20),
            Pc("velho-ligado", Alice, true, 10),
        };

        PcAgentResolver.Choose(all, Alice)!.Slug.Should().Be("velho-ligado");
        PcAgentResolver.Choose(all.Where(c => c.Slug == "velho-desligado"), Alice)!.Slug.Should().Be("velho-desligado");
    }
}

public sealed class PcKeyBudgetTests
{
    private static readonly Guid Alice = Guid.Parse("22222222-2222-7222-8222-222222222222");
    private static readonly Guid Bruno = Guid.Parse("33333333-3333-7333-8333-333333333333");

    [Fact]
    public void EveryRepeatCountsAsAPress_AndThePerMinuteCeilingIsPerAccount()
    {
        var budget = new PcKeyBudget(new FakeTimeProvider(DateTimeOffset.UnixEpoch));

        budget.TryTake(Alice, PcKeyBudget.PressesPerMinute - 1).Should().BeTrue();
        budget.TryTake(Alice, 1).Should().BeTrue();
        budget.TryTake(Alice, 1).Should().BeFalse();
        budget.TryTake(Bruno, 50).Should().BeTrue("o teto é de cada conta");
    }

    [Fact]
    public void ARefundGivesBackWhatWasNeverSent_NeverBelowZero_AndOnlyInTheCurrentWindow()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UnixEpoch);
        var budget = new PcKeyBudget(time);
        budget.TryTake(Alice, PcKeyBudget.PressesPerMinute).Should().BeTrue();
        budget.TryTake(Alice, 1).Should().BeFalse();

        budget.Refund(Alice, 50);
        budget.TryTake(Alice, 50).Should().BeTrue("os 50 que não saíram voltaram");
        budget.TryTake(Alice, 1).Should().BeFalse();

        budget.Refund(Bruno, 10); // sem janela: nada acontece
        budget.TryTake(Bruno, PcKeyBudget.PressesPerMinute).Should().BeTrue();
        budget.Refund(Bruno, PcKeyBudget.PressesPerMinute * 3);
        budget.TryTake(Bruno, PcKeyBudget.PressesPerMinute).Should().BeTrue("devolver demais não cria crédito negativo, só zera");
        budget.TryTake(Bruno, 1).Should().BeFalse();

        time.Advance(TimeSpan.FromMinutes(2));
        budget.Refund(Alice, 100); // janela vencida: ignorado
        budget.TryTake(Alice, PcKeyBudget.PressesPerMinute).Should().BeTrue();
        budget.TryTake(Alice, 1).Should().BeFalse("a devolução tardia não aumentou o teto");
    }

    [Fact]
    public void TheWindowOfOneAccountRestartsWithoutAnyoneElseNeedingAScan()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UnixEpoch);
        var budget = new PcKeyBudget(time);
        budget.TryTake(Alice, PcKeyBudget.PressesPerMinute).Should().BeTrue();
        budget.TryTake(Bruno, 5).Should().BeTrue();

        time.Advance(TimeSpan.FromSeconds(61));

        budget.TryTake(Alice, PcKeyBudget.PressesPerMinute).Should().BeTrue("a janela de Alice venceu");
        budget.TryTake(Alice, 1).Should().BeFalse();
    }

    [Fact]
    public void ARefusedRequestSpendsNothing_AndTheWindowOpensAgainAfterAMinute()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UnixEpoch);
        var budget = new PcKeyBudget(time);
        budget.TryTake(Alice, PcKeyBudget.PressesPerMinute - 10).Should().BeTrue();

        budget.TryTake(Alice, 11).Should().BeFalse();
        budget.TryTake(Alice, 10).Should().BeTrue("o pedido recusado não gastou nada");

        time.Advance(TimeSpan.FromMinutes(1));
        budget.TryTake(Alice, PcKeyBudget.PressesPerMinute).Should().BeTrue();
    }
}
