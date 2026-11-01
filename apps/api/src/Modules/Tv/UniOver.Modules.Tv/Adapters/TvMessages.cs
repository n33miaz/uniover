using System.Collections.Frozen;
using System.Text.Json;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Monta as mensagens da TV a partir dos tipos gerados do contrato: a tecla, a direção e o alvo nunca vêm de texto
/// livre. Os conversores gerados são internos do protocolo, então o corpo sai da serialização pública da mensagem
/// inteira (só o <c>body</c> é aproveitado; o envelope é montado e validado pelo Devices).
/// </summary>
internal static class TvMessages
{
    /// <summary>
    /// Teclas aceitas na API, pelo nome do contrato (ex.: <c>VOLUME_UP</c>, <c>NUM_0</c>, <c>GUIDE</c>). A lista permitida é
    /// a do <c>tv.key.v3</c>, que contém todas as do <c>v2</c>: nada fora do contrato chega ao agente.
    /// </summary>
    public static FrozenDictionary<string, TvKeyV3BodyKey> Keys { get; } = Enum.GetValues<TvKeyV3BodyKey>()
        .ToFrozenDictionary(WireName, key => key, StringComparer.Ordinal);

    /// <summary>As teclas que o <c>tv.key.v2</c> já conhece: seguem nele, para um agente mais velho continuar entendendo.</summary>
    private static readonly FrozenDictionary<string, TvKeyV2BodyKey> LegacyKeys = Enum.GetValues<TvKeyV2BodyKey>()
        .ToFrozenDictionary(WireName, key => key, StringComparer.Ordinal);

    public static FrozenDictionary<string, TvKeyV2BodyDirection> Directions { get; } = Enum.GetValues<TvKeyV2BodyDirection>()
        .ToFrozenDictionary(WireName, direction => direction, StringComparer.Ordinal);

    /// <summary>
    /// A tecla vai no <c>tv.key.v2</c> quando ele a conhece (o agente de antes segue servido) e no <c>v3</c> só quando ela
    /// é nova (guia, ferramentas, cores, mídia...).
    /// </summary>
    public static TvMessage Key(TvKeyV3BodyKey key, TvKeyV2BodyDirection? direction = null)
    {
        if (LegacyKeys.TryGetValue(WireName(key), out var legacy))
        {
            return new(AgentMessageTypes.TvKeyV2, BodyOf(
                new TvKeyV2Message { Body = new TvKeyV2Body { Key = legacy, Direction = direction } }.ToJson()));
        }

        TvKeyV3BodyDirection? v3Direction = direction is { } value ? Enum.Parse<TvKeyV3BodyDirection>(value.ToString()) : null;
        return new(AgentMessageTypes.TvKeyV3, BodyOf(
            new TvKeyV3Message { Body = new TvKeyV3Body { Key = key, Direction = v3Direction } }.ToJson()));
    }

    /// <summary>
    /// O desligamento com leitura: o agente lê a energia da TV, aperta <c>POWER</c> só se ela estiver ligada e confirma. A
    /// API só o manda a agente que declarou a capacidade <c>tv.power.off.v1</c>.
    /// </summary>
    public static TvMessage PowerOff() =>
        new(AgentMessageTypes.TvPowerOffV1, BodyOf(new TvPowerOffV1Message { Body = new TvPowerOffV1Body() }.ToJson()));

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

    /// <summary>
    /// Pede à TV Samsung o aviso "Permitir" do UniOver. É o único caminho que faz o agente falar com a TV quando a
    /// permissão foi perdida: ele nunca repete o pedido sozinho. A API só a manda a agente com <c>tv.permission.v1</c>.
    /// </summary>
    public static TvMessage PermissionRequest() =>
        new(AgentMessageTypes.TvPermissionRequestV1, BodyOf(
            new TvPermissionRequestV1Message { Body = new TvPermissionRequestV1Body() }.ToJson()));

    /// <summary>Pede ao agente que procure TVs compatíveis na rede local dele. O <paramref name="requestId"/> volta na lista.</summary>
    public static TvMessage Discover(Guid requestId) =>
        new(AgentMessageTypes.TvDiscoverV1, BodyOf(
            new TvDiscoverV1Message { Body = new TvDiscoverV1Body { RequestId = requestId } }.ToJson()));

    public static TvMessage Wake() =>
        new(AgentMessageTypes.TvWakeV1, BodyOf(new TvWakeV1Message { Body = new TvWakeV1Body() }.ToJson()));

    public static TvMessage AppsRefresh() =>
        new(AgentMessageTypes.TvAppsRefreshV1, BodyOf(new TvAppsRefreshV1Message { Body = new TvAppsRefreshV1Body() }.ToJson()));

    /// <summary>
    /// Pede a limpeza da TV. O <paramref name="requestId"/> é gerado pela API e volta no relatório do agente: é o que
    /// liga as duas mensagens, porque o <c>id</c> do envelope é montado pelo Devices.
    /// </summary>
    public static TvMessage Cleanup(Guid requestId) =>
        new(AgentMessageTypes.TvCleanupV1, BodyOf(
            new TvCleanupV1Message { Body = new TvCleanupV1Body { RequestId = requestId } }.ToJson()));

    /// <summary>
    /// Um passo do TV Livre. O <paramref name="requestId"/> é gerado pela API e volta no estado do agente (o <c>id</c> do
    /// envelope é do Devices). Cada passo só leva os campos que o contrato lhe reserva: <c>revision</c>, <c>configJson</c> e
    /// <c>photoId</c> no <c>apply</c>; <c>disableFactory</c> no <c>set-home</c>; <c>uninstall</c> no <c>restore</c>;
    /// <c>disable</c> e <c>enable</c> no <c>set-apps</c>. A API só o manda a agente que anuncia <c>tv.livre.v1</c>.
    /// </summary>
    public static TvMessage TvLivre(
        Guid requestId,
        TvLivreAction action,
        int? revision = null,
        string? configJson = null,
        Guid? photoId = null,
        bool? disableFactory = null,
        bool? uninstall = null,
        IReadOnlyList<string>? disable = null,
        IReadOnlyList<string>? enable = null) =>
        new(AgentMessageTypes.TvLivreV1, BodyOf(
            new TvLivreV1Message
            {
                Body = new TvLivreV1Body
                {
                    RequestId = requestId,
                    // O nome de cada valor do enum gerado é o do contrato em PascalCase (set-home vira SetHome).
                    Action = Enum.Parse<TvLivreV1BodyAction>(action.ToString()),
                    Revision = revision,
                    ConfigJson = configJson,
                    PhotoId = photoId,
                    DisableFactory = disableFactory,
                    Uninstall = uninstall,
                    Disable = disable?.ToArray(),
                    Enable = enable?.ToArray(),
                },
            }.ToJson()));

    /// <summary>
    /// Um pedaço da foto do fundo. Cada pedaço vai numa mensagem própria porque o transporte recusa as de mais de 64 KB; o
    /// <paramref name="sha256"/> é o da foto inteira (o mesmo em todos os pedaços) e o agente o confere ao juntar.
    /// </summary>
    public static TvMessage TvLivrePhotoChunk(Guid photoId, int index, int total, string sha256, ReadOnlySpan<byte> data) =>
        new(AgentMessageTypes.TvLivrePhotoV1, BodyOf(
            new TvLivrePhotoV1Message
            {
                Body = new TvLivrePhotoV1Body
                {
                    PhotoId = photoId,
                    Index = index,
                    Total = total,
                    Sha256 = sha256,
                    Data = Convert.ToBase64String(data),
                },
            }.ToJson()));

    /// <summary>Nome do valor no contrato (o que viaja no JSON), descoberto pelo próprio conversor gerado.</summary>
    private static string WireName(TvKeyV2BodyKey key) =>
        BodyOf(new TvKeyV2Message { Body = new TvKeyV2Body { Key = key } }.ToJson()).GetProperty("key").GetString()!;

    private static string WireName(TvKeyV3BodyKey key) =>
        BodyOf(new TvKeyV3Message { Body = new TvKeyV3Body { Key = key } }.ToJson()).GetProperty("key").GetString()!;

    private static string WireName(TvKeyV2BodyDirection direction) =>
        BodyOf(new TvKeyV2Message { Body = new TvKeyV2Body { Key = TvKeyV2BodyKey.Ok, Direction = direction } }.ToJson())
            .GetProperty("direction").GetString()!;

    private static JsonElement BodyOf(string messageJson)
    {
        using var document = JsonDocument.Parse(messageJson);
        return document.RootElement.GetProperty("body").Clone();
    }
}
