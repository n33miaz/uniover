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

    /// <summary>
    /// Capacidade do <c>hello</c> de quem entende <c>pc.key.v2</c> (teclas novas, repetição e segurar modificador). Só o
    /// agente que a declara recebe a v2; a API manda a v1 sempre que o pedido cabe nela.
    /// </summary>
    public const string KeyV2Capability = "pc.key.v2";

    public static FrozenDictionary<string, PcClickV1BodyButton> Buttons { get; } = Enum.GetValues<PcClickV1BodyButton>()
        .ToFrozenDictionary(WireName, button => button, StringComparer.Ordinal);

    public static FrozenDictionary<string, PcClickV1BodyAction> ClickActions { get; } = Enum.GetValues<PcClickV1BodyAction>()
        .ToFrozenDictionary(WireName, action => action, StringComparer.Ordinal);

    public static FrozenDictionary<string, PcKeyV1BodyKey> Keys { get; } = Enum.GetValues<PcKeyV1BodyKey>()
        .ToFrozenDictionary(WireName, key => key, StringComparer.Ordinal);

    public static FrozenDictionary<string, PcKeyV1BodyModifiersItem> Modifiers { get; } = Enum.GetValues<PcKeyV1BodyModifiersItem>()
        .ToFrozenDictionary(WireName, modifier => modifier, StringComparer.Ordinal);

    public static FrozenDictionary<string, PcKeyV2BodyKey> KeysV2 { get; } = Enum.GetValues<PcKeyV2BodyKey>()
        .ToFrozenDictionary(WireName, key => key, StringComparer.Ordinal);

    public static FrozenDictionary<string, PcKeyV2BodyModifiersItem> ModifiersV2 { get; } = Enum.GetValues<PcKeyV2BodyModifiersItem>()
        .ToFrozenDictionary(WireName, modifier => modifier, StringComparer.Ordinal);

    public static FrozenDictionary<string, PcKeyV2BodyAction> KeyActions { get; } = Enum.GetValues<PcKeyV2BodyAction>()
        .ToFrozenDictionary(WireName, action => action, StringComparer.Ordinal);

    /// <summary>As teclas que dá para segurar (<c>DOWN</c>) e soltar (<c>UP</c>): só os modificadores.</summary>
    public static FrozenSet<string> HoldableKeys { get; } = new[] { "CTRL", "ALT", "SHIFT", "WIN" }.ToFrozenSet(StringComparer.Ordinal);

    public static FrozenDictionary<string, PcMediaV1BodyAction> MediaActions { get; } = Enum.GetValues<PcMediaV1BodyAction>()
        .ToFrozenDictionary(WireName, action => action, StringComparer.Ordinal);

    public static FrozenDictionary<string, PcPowerV1BodyAction> PowerActions { get; } = Enum.GetValues<PcPowerV1BodyAction>()
        .ToFrozenDictionary(WireName, action => action, StringComparer.Ordinal);

    public static OutboundMessage Pointer(int dx, int dy, int scrollX, int scrollY) =>
        Live(AgentMessageTypes.PcPointerV1, BodyOf(new PcPointerV1Message
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
        Live(AgentMessageTypes.PcClickV1, BodyOf(new PcClickV1Message
        {
            Body = new PcClickV1Body { Button = button, Action = action },
        }.ToJson()));

    public static OutboundMessage Key(PcKeyV1BodyKey key, IReadOnlyList<PcKeyV1BodyModifiersItem> modifiers) =>
        Live(AgentMessageTypes.PcKeyV1, BodyOf(new PcKeyV1Message
        {
            Body = new PcKeyV1Body { Key = key, Modifiers = modifiers.Count == 0 ? null : [.. modifiers] },
        }.ToJson()));

    /// <summary>
    /// A v1 serve todo pedido que ela sabe exprimir (tecla da v1, uma vez, apertada e solta): o agente anterior à v2 segue
    /// servido. Só o que a v1 não diz precisa da v2 (e da capacidade <see cref="KeyV2Capability"/>).
    /// </summary>
    public static bool KeyFitsV1(PcKeyRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        return Keys.ContainsKey(request.Key!)
            && (request.Repeat ?? 1) == 1
            && (request.Action is null || KeyActions[request.Action] == PcKeyV2BodyAction.Press);
    }

    /// <summary>Monta a mensagem da tecla (v1 quando cabe, v2 quando não) de um pedido já validado.</summary>
    public static OutboundMessage KeyFor(PcKeyRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (KeyFitsV1(request))
        {
            return Key(Keys[request.Key!], (request.Modifiers ?? []).Select(m => Modifiers[m]).ToList());
        }

        var modifiers = (request.Modifiers ?? []).Select(m => ModifiersV2[m]).ToList();
        var repeat = request.Repeat is > 1 ? request.Repeat : null;
        var action = request.Action is null ? PcKeyV2BodyAction.Press : KeyActions[request.Action];
        return Live(AgentMessageTypes.PcKeyV2, BodyOf(new PcKeyV2Message
        {
            Body = new PcKeyV2Body
            {
                Key = KeysV2[request.Key!],
                Modifiers = modifiers.Count == 0 ? null : [.. modifiers],
                Repeat = repeat,
                // PRESS é o padrão do contrato: só vai quando muda alguma coisa.
                Action = action == PcKeyV2BodyAction.Press ? null : action,
            },
        }.ToJson()));
    }

    public static OutboundMessage Text(string text) =>
        Live(AgentMessageTypes.PcTextV1, BodyOf(new PcTextV1Message { Body = new PcTextV1Body { Text = text } }.ToJson()));

    public static OutboundMessage Media(PcMediaV1BodyAction action, int steps) =>
        Live(AgentMessageTypes.PcMediaV1, BodyOf(new PcMediaV1Message
        {
            Body = new PcMediaV1Body { Action = action, Steps = steps == 1 ? null : steps },
        }.ToJson()));

    public static OutboundMessage Power(PcPowerV1BodyAction action) =>
        Live(AgentMessageTypes.PcPowerV1, BodyOf(new PcPowerV1Message { Body = new PcPowerV1Body { Action = action } }.ToJson()));

    public static OutboundMessage AppLaunch(string appId) =>
        Live(AgentMessageTypes.PcAppLaunchV1, BodyOf(new PcAppLaunchV1Message { Body = new PcAppLaunchV1Body { AppId = appId } }.ToJson()));

    /// <summary>
    /// Todo comando do PC é ao vivo: sem sessão viva agora, falha na hora em vez de esperar a reconexão do agente (ver
    /// <see cref="AgentDelivery.Immediate"/>).
    /// </summary>
    private static OutboundMessage Live(string type, JsonElement body) => new(type, body, AgentDelivery.Immediate);

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

    private static string WireName(PcKeyV2BodyKey key) =>
        BodyOf(new PcKeyV2Message { Body = new PcKeyV2Body { Key = key } }.ToJson()).GetProperty("key").GetString()!;

    private static string WireName(PcKeyV2BodyModifiersItem modifier) =>
        BodyOf(new PcKeyV2Message { Body = new PcKeyV2Body { Key = PcKeyV2BodyKey.A, Modifiers = [modifier] } }.ToJson())
            .GetProperty("modifiers")[0].GetString()!;

    private static string WireName(PcKeyV2BodyAction action) =>
        BodyOf(new PcKeyV2Message { Body = new PcKeyV2Body { Key = PcKeyV2BodyKey.Alt, Action = action } }.ToJson())
            .GetProperty("action").GetString()!;

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
