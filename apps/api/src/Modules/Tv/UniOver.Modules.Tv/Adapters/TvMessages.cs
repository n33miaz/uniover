using System.Collections.Frozen;
using System.Text.Json;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Monta as mensagens da TV a partir dos tipos gerados do contrato: a tecla, a direção e o alvo nunca vêm de texto
/// livre. Os conversores gerados são internos do protocolo, então o corpo sai da serialização pública da mensagem
/// inteira (só o <c>body</c> é aproveitado; o envelope é montado e validado pelo Devices).
/// </summary>
internal static class TvMessages
{
    /// <summary>Teclas aceitas na API, pelo nome do contrato (ex.: <c>VOLUME_UP</c>, <c>NUM_0</c>).</summary>
    public static FrozenDictionary<string, TvKeyV2BodyKey> Keys { get; } = Enum.GetValues<TvKeyV2BodyKey>()
        .ToFrozenDictionary(WireName, key => key, StringComparer.Ordinal);

    public static FrozenDictionary<string, TvKeyV2BodyDirection> Directions { get; } = Enum.GetValues<TvKeyV2BodyDirection>()
        .ToFrozenDictionary(WireName, direction => direction, StringComparer.Ordinal);

    public static TvMessage Key(TvKeyV2BodyKey key, TvKeyV2BodyDirection? direction = null) =>
        new(AgentMessageTypes.TvKeyV2, BodyOf(
            new TvKeyV2Message { Body = new TvKeyV2Body { Key = key, Direction = direction } }.ToJson()));

    public static TvMessage Text(string text) =>
        new(AgentMessageTypes.TvTextV1, BodyOf(
            new TvTextV1Message { Body = new TvTextV1Body { Text = text } }.ToJson()));

    public static TvMessage LaunchPackage(string package) =>
        new(AgentMessageTypes.TvAppLaunchV1, BodyOf(
            new TvAppLaunchV1Message
            {
                Body = new TvAppLaunchV1Body
                {
                    Target = new TvAppLaunchV1BodyTarget { Kind = TvAppLaunchV1BodyTargetKind.Package, Value = package },
                },
            }.ToJson()));

    public static TvMessage Wake() =>
        new(AgentMessageTypes.TvWakeV1, BodyOf(new TvWakeV1Message { Body = new TvWakeV1Body() }.ToJson()));

    public static TvMessage AppsRefresh() =>
        new(AgentMessageTypes.TvAppsRefreshV1, BodyOf(new TvAppsRefreshV1Message { Body = new TvAppsRefreshV1Body() }.ToJson()));

    /// <summary>Nome do valor no contrato (o que viaja no JSON), descoberto pelo próprio conversor gerado.</summary>
    private static string WireName(TvKeyV2BodyKey key) =>
        BodyOf(new TvKeyV2Message { Body = new TvKeyV2Body { Key = key } }.ToJson()).GetProperty("key").GetString()!;

    private static string WireName(TvKeyV2BodyDirection direction) =>
        BodyOf(new TvKeyV2Message { Body = new TvKeyV2Body { Key = TvKeyV2BodyKey.Ok, Direction = direction } }.ToJson())
            .GetProperty("direction").GetString()!;

    private static JsonElement BodyOf(string messageJson)
    {
        using var document = JsonDocument.Parse(messageJson);
        return document.RootElement.GetProperty("body").Clone();
    }
}
