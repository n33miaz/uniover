using System.Collections.Frozen;
using System.Text.Json;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.Modules.Devices.Contracts.Agents;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>
/// Monta as mensagens do controle do PC a partir dos tipos gerados do contrato: o botão, a tecla, a ação e o favorito
/// nunca vêm de texto livre. Os conversores gerados são internos do protocolo, então o corpo sai da serialização
/// pública da mensagem inteira (só o <c>body</c> é aproveitado; o envelope é montado e validado pelo gateway).
/// </summary>
internal static class PcMessages
{
    /// <summary>Capacidade do <c>hello</c> de quem tem o controle do PC ligado.</summary>
    public const string Capability = "pc.control.v1";

    public static FrozenDictionary<string, PcClickV1BodyButton> Buttons { get; } = Enum.GetValues<PcClickV1BodyButton>()
        .ToFrozenDictionary(WireName, button => button, StringComparer.Ordinal);

    public static FrozenDictionary<string, PcClickV1BodyAction> ClickActions { get; } = Enum.GetValues<PcClickV1BodyAction>()
        .ToFrozenDictionary(WireName, action => action, StringComparer.Ordinal);

    public static FrozenDictionary<string, PcKeyV1BodyKey> Keys { get; } = Enum.GetValues<PcKeyV1BodyKey>()
        .ToFrozenDictionary(WireName, key => key, StringComparer.Ordinal);

    public static FrozenDictionary<string, PcKeyV1BodyModifiersItem> Modifiers { get; } = Enum.GetValues<PcKeyV1BodyModifiersItem>()
        .ToFrozenDictionary(WireName, modifier => modifier, StringComparer.Ordinal);

    public static FrozenDictionary<string, PcMediaV1BodyAction> MediaActions { get; } = Enum.GetValues<PcMediaV1BodyAction>()
        .ToFrozenDictionary(WireName, action => action, StringComparer.Ordinal);

    public static FrozenDictionary<string, PcPowerV1BodyAction> PowerActions { get; } = Enum.GetValues<PcPowerV1BodyAction>()
        .ToFrozenDictionary(WireName, action => action, StringComparer.Ordinal);

    public static OutboundMessage Pointer(int dx, int dy, int scrollX, int scrollY) =>
        new(AgentMessageTypes.PcPointerV1, BodyOf(new PcPointerV1Message
        {
            Body = new PcPointerV1Body
            {
                Dx = dx,
                Dy = dy,
                ScrollX = scrollX == 0 ? null : scrollX,
                ScrollY = scrollY == 0 ? null : scrollY,
            },
        }.ToJson()));

    public static OutboundMessage Click(PcClickV1BodyButton button, PcClickV1BodyAction action) =>
        new(AgentMessageTypes.PcClickV1, BodyOf(new PcClickV1Message
        {
            Body = new PcClickV1Body { Button = button, Action = action },
        }.ToJson()));

    public static OutboundMessage Key(PcKeyV1BodyKey key, IReadOnlyList<PcKeyV1BodyModifiersItem> modifiers) =>
        new(AgentMessageTypes.PcKeyV1, BodyOf(new PcKeyV1Message
        {
            Body = new PcKeyV1Body { Key = key, Modifiers = modifiers.Count == 0 ? null : [.. modifiers] },
        }.ToJson()));

    public static OutboundMessage Text(string text) =>
        new(AgentMessageTypes.PcTextV1, BodyOf(new PcTextV1Message { Body = new PcTextV1Body { Text = text } }.ToJson()));

    public static OutboundMessage Media(PcMediaV1BodyAction action, int steps) =>
        new(AgentMessageTypes.PcMediaV1, BodyOf(new PcMediaV1Message
        {
            Body = new PcMediaV1Body { Action = action, Steps = steps == 1 ? null : steps },
        }.ToJson()));

    public static OutboundMessage Power(PcPowerV1BodyAction action) =>
        new(AgentMessageTypes.PcPowerV1, BodyOf(new PcPowerV1Message { Body = new PcPowerV1Body { Action = action } }.ToJson()));

    public static OutboundMessage AppLaunch(string appId) =>
        new(AgentMessageTypes.PcAppLaunchV1, BodyOf(new PcAppLaunchV1Message { Body = new PcAppLaunchV1Body { AppId = appId } }.ToJson()));

    private static string WireName(PcClickV1BodyButton button) =>
        BodyOf(new PcClickV1Message { Body = new PcClickV1Body { Button = button } }.ToJson()).GetProperty("button").GetString()!;

    private static string WireName(PcClickV1BodyAction action) =>
        BodyOf(new PcClickV1Message { Body = new PcClickV1Body { Button = PcClickV1BodyButton.Left, Action = action } }.ToJson())
            .GetProperty("action").GetString()!;

    private static string WireName(PcKeyV1BodyKey key) =>
        BodyOf(new PcKeyV1Message { Body = new PcKeyV1Body { Key = key } }.ToJson()).GetProperty("key").GetString()!;

    private static string WireName(PcKeyV1BodyModifiersItem modifier) =>
        BodyOf(new PcKeyV1Message { Body = new PcKeyV1Body { Key = PcKeyV1BodyKey.A, Modifiers = [modifier] } }.ToJson())
            .GetProperty("modifiers")[0].GetString()!;

    private static string WireName(PcMediaV1BodyAction action) =>
        BodyOf(new PcMediaV1Message { Body = new PcMediaV1Body { Action = action } }.ToJson()).GetProperty("action").GetString()!;

    private static string WireName(PcPowerV1BodyAction action) =>
        BodyOf(new PcPowerV1Message { Body = new PcPowerV1Body { Action = action } }.ToJson()).GetProperty("action").GetString()!;

    private static JsonElement BodyOf(string messageJson)
    {
        using var document = JsonDocument.Parse(messageJson);
        return document.RootElement.GetProperty("body").Clone();
    }
}
