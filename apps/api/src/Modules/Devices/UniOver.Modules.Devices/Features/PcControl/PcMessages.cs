using System.Collections.Frozen;
using System.Text.Json;
using System.Text.Json.Nodes;
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

    /// <summary>
    /// Capacidade do <c>hello</c> de quem entende <c>pc.text.v2</c> (apagar, digitar e apertar uma tecla numa mensagem só).
    /// </summary>
    public const string TextV2Capability = "pc.text.v2";

    /// <summary>
    /// Capacidade do <c>hello</c> de quem entende <c>pc.click.v2</c> (clique com modificadores e com o intervalo do toque anterior).
    /// </summary>
    public const string ClickV2Capability = "pc.click.v2";

    /// <summary>
    /// Capacidade do <c>hello</c> de quem entende <c>pc.pointer.zoom.v1</c> (o zoom da pinça: Ctrl apertado e a roda do mouse). É uma
    /// mensagem nova, sem v1 equivalente: só o agente que a declara a recebe.
    /// </summary>
    public const string ZoomCapability = "pc.pointer.zoom.v1";

    /// <summary>
    /// Capacidade do <c>hello</c> de quem entende <c>pc.volume.v1</c> (volume absoluto, de 0 a 100, e mudo) e manda o nível de agora em
    /// <c>pc.volume.state.v1</c>. Mensagem nova, sem v1 equivalente: só o agente que a declara a recebe.
    /// </summary>
    public const string VolumeCapability = "pc.volume.v1";

    /// <summary>Capacidade do canal direto (WebRTC): o agente só a declara depois de a API a listar em <c>features</c>.</summary>
    public const string RtcCapability = "pc.rtc.v1";

    public static FrozenDictionary<string, PcClickV1BodyButton> Buttons { get; } = Enum.GetValues<PcClickV1BodyButton>()
        .ToFrozenDictionary(WireName, button => button, StringComparer.Ordinal);

    public static FrozenDictionary<string, PcClickV1BodyAction> ClickActions { get; } = Enum.GetValues<PcClickV1BodyAction>()
        .ToFrozenDictionary(WireName, action => action, StringComparer.Ordinal);

    public static FrozenDictionary<string, PcClickV2BodyModifiersItem> ClickModifiers { get; } = Enum.GetValues<PcClickV2BodyModifiersItem>()
        .ToFrozenDictionary(WireName, modifier => modifier, StringComparer.Ordinal);

    /// <summary>As teclas que a <c>pc.text.v2</c> aperta depois de digitar.</summary>
    public static FrozenDictionary<string, PcTextV2BodyKey> TextKeys { get; } = Enum.GetValues<PcTextV2BodyKey>()
        .ToFrozenDictionary(WireName, key => key, StringComparer.Ordinal);

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

    /// <summary>
    /// A mesma mensagem com o <c>seq</c> do pedido (o contador comum dos de entrada pela nuvem) e a <c>epoch</c> da página no corpo. Só para um agente
    /// que declarou <see cref="RtcCapability"/>: o esquema dos comandos de entrada de um agente anterior é fechado.
    /// </summary>
    public static OutboundMessage WithSeq(OutboundMessage message, int? seq, string? epoch = null)
    {
        ArgumentNullException.ThrowIfNull(message);
        var body = JsonNode.Parse(message.Body.GetRawText())!.AsObject();
        if (seq is { } number)
        {
            body["seq"] = number;
        }

        if (epoch is not null)
        {
            body["epoch"] = epoch;
        }

        return message with { Body = JsonSerializer.SerializeToElement(body) };
    }

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

    /// <summary>
    /// A v1 serve todo clique que ela sabe exprimir (sem modificador e sem intervalo): o agente anterior à v2 segue servido.
    /// Só modificador ou intervalo precisam da v2 (e da capacidade <see cref="ClickV2Capability"/>).
    /// </summary>
    public static bool ClickFitsV1(PcClickRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        return (request.Modifiers ?? []).Length == 0 && (request.GapMs ?? 0) == 0;
    }

    /// <summary>Monta a mensagem do clique (v1 quando cabe, v2 quando não) de um pedido já validado.</summary>
    public static OutboundMessage ClickFor(PcClickRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        var action = request.Action is null ? PcClickV1BodyAction.Click : ClickActions[request.Action];
        if (ClickFitsV1(request))
        {
            return Click(Buttons[request.Button!], action);
        }

        var modifiers = (request.Modifiers ?? []).Select(m => ClickModifiers[m]).ToList();
        return Live(AgentMessageTypes.PcClickV2, BodyOf(new PcClickV2Message
        {
            Body = new PcClickV2Body
            {
                Button = Enum.Parse<PcClickV2BodyButton>(Buttons[request.Button!].ToString()),
                // CLICK é o padrão do contrato: só vai o que muda.
                Action = action == PcClickV1BodyAction.Double ? PcClickV2BodyAction.Double : null,
                Modifiers = modifiers.Count == 0 ? null : [.. modifiers],
                GapMs = request.GapMs is > 0 ? request.GapMs : null,
            },
        }.ToJson()));
    }

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

    /// <summary>O pedido tem texto, o que apagar ou uma tecla no fim: sem nada disso não há o que fazer.</summary>
    public static bool TextEditsAnything(PcTextRequest? request) =>
        request is not null && (!string.IsNullOrEmpty(request.Text) || (request.Erase ?? 0) > 0 || request.Key is not null);

    /// <summary>
    /// A v1 serve o texto puro: sem apagar e sem tecla no fim, o agente anterior à v2 segue servido. Só apagar ou apertar uma
    /// tecla depois precisam da v2 (e da capacidade <see cref="TextV2Capability"/>).
    /// </summary>
    public static bool TextFitsV1(PcTextRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        return (request.Erase ?? 0) == 0 && request.Key is null && !string.IsNullOrEmpty(request.Text);
    }

    /// <summary>Quantos apertos de tecla o pedido faz (cada Backspace e a tecla do fim); o texto puro não conta.</summary>
    public static int TextPresses(PcTextRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        return (request.Erase ?? 0) + (request.Key is null ? 0 : 1);
    }

    /// <summary>Monta a mensagem do texto (v1 quando cabe, v2 quando não) de um pedido já validado.</summary>
    public static OutboundMessage TextFor(PcTextRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (TextFitsV1(request))
        {
            return Text(request.Text!);
        }

        return Live(AgentMessageTypes.PcTextV2, BodyOf(new PcTextV2Message
        {
            Body = new PcTextV2Body
            {
                Erase = request.Erase is > 0 ? request.Erase : null,
                Text = string.IsNullOrEmpty(request.Text) ? null : request.Text,
                Key = request.Key is null ? null : TextKeys[request.Key],
            },
        }.ToJson()));
    }

    public static OutboundMessage Media(PcMediaV1BodyAction action, int steps) =>
        Live(AgentMessageTypes.PcMediaV1, BodyOf(new PcMediaV1Message
        {
            Body = new PcMediaV1Body { Action = action, Steps = steps == 1 ? null : steps },
        }.ToJson()));

    /// <summary>O zoom da pinça: `steps` cliques de roda com o Ctrl apertado (positivo aproxima), de um pedido já validado.</summary>
    public static OutboundMessage Zoom(int steps) =>
        Live(AgentMessageTypes.PcPointerZoomV1, BodyOf(new PcPointerZoomV1Message
        {
            Body = new PcPointerZoomV1Body { Steps = steps },
        }.ToJson()));

    /// <summary>O volume absoluto de um pedido já validado: só vai ao agente o que o pedido traz (`level` e/ou `muted`).</summary>
    public static OutboundMessage Volume(int? level, bool? muted) =>
        Live(AgentMessageTypes.PcVolumeV1, BodyOf(new PcVolumeV1Message
        {
            Body = new PcVolumeV1Body { Level = level, Muted = muted },
        }.ToJson()));

    public static OutboundMessage Power(PcPowerV1BodyAction action) =>
        Live(AgentMessageTypes.PcPowerV1, BodyOf(new PcPowerV1Message { Body = new PcPowerV1Body { Action = action } }.ToJson()));

    public static OutboundMessage AppLaunch(string appId) =>
        Live(AgentMessageTypes.PcAppLaunchV1, BodyOf(new PcAppLaunchV1Message { Body = new PcAppLaunchV1Body { AppId = appId } }.ToJson()));

    /// <summary>A oferta do canal direto, com o token de uso único que a primeira mensagem do canal precisa apresentar.</summary>
    public static OutboundMessage RtcOffer(Guid sessionId, string sdp, string token, int tokenTtlSeconds, int maxLifetimeSeconds) =>
        Live(AgentMessageTypes.PcRtcOfferV1, BodyOf(new PcRtcOfferV1Message
        {
            Body = new PcRtcOfferV1Body
            {
                SessionId = sessionId,
                Sdp = sdp,
                Token = token,
                TokenTtlSeconds = tokenTtlSeconds,
                MaxLifetimeSeconds = maxLifetimeSeconds,
            },
        }.ToJson()));

    public static OutboundMessage RtcCandidate(Guid sessionId, string candidate, string? sdpMid, long? sdpMLineIndex) =>
        Live(AgentMessageTypes.PcRtcCandidateV1, BodyOf(new PcRtcCandidateV1Message
        {
            Body = new PcRtcCandidateV1Body { SessionId = sessionId, Candidate = candidate, SdpMid = sdpMid, SdpMLineIndex = sdpMLineIndex },
        }.ToJson()));

    public static OutboundMessage RtcClose(Guid sessionId, PcRtcCloseV1BodyReason reason) =>
        Live(AgentMessageTypes.PcRtcCloseV1, BodyOf(new PcRtcCloseV1Message
        {
            Body = new PcRtcCloseV1Body { SessionId = sessionId, Reason = reason },
        }.ToJson()));

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

    private static string WireName(PcClickV2BodyModifiersItem modifier) =>
        BodyOf(new PcClickV2Message { Body = new PcClickV2Body { Button = PcClickV2BodyButton.Left, Modifiers = [modifier] } }.ToJson())
            .GetProperty("modifiers")[0].GetString()!;

    private static string WireName(PcTextV2BodyKey key) =>
        BodyOf(new PcTextV2Message { Body = new PcTextV2Body { Key = key } }.ToJson()).GetProperty("key").GetString()!;

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
