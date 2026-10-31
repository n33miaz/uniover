using System.Collections.Frozen;
using System.Globalization;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Tv.Features.Siri;

/// <summary>
/// O catálogo FECHADO do que um atalho do iPhone pode mandar à TV. Cada ação tem um código estável (gravado na chave e na
/// trilha), a permissão que a conta precisa ter e o que ela faz. Não existe "ligar": nenhuma rota da API liga a TV (o
/// <c>wake</c> só aquece a conexão e o desligar nunca religa), então a lista não promete o que o servidor não entrega.
/// A tecla <c>POWER</c> também nunca entra: desligar tem a ação própria, que lê a TV antes.
/// </summary>
internal static class SiriActions
{
    public const string PowerOff = "power_off";
    public const string VolumeUp = "volume_up";
    public const string VolumeDown = "volume_down";
    public const string Mute = "mute";

    /// <summary>Prefixo da ação "apertar uma tecla": <c>key:HOME</c>. O que vem depois precisa estar em <see cref="Keys"/>.</summary>
    public const string KeyPrefix = "key:";

    /// <summary>Prefixo da ação "abrir um app": <c>app:{id do atalho}</c>. O pacote vem da lista da TV, nunca do pedido.</summary>
    public const string AppPrefix = "app:";

    /// <summary>Os pedidos de tecla e de app trazem a ação como <c>key</c> e <c>app</c>, com o valor num campo à parte.</summary>
    public const string KeyAction = "key";

    public const string AppAction = "app";

    /// <summary>Teclas de navegação que um atalho pode apertar (as mesmas do controle básico; nada de números nem de ligar).</summary>
    public static IReadOnlyList<string> Keys { get; } =
        ["HOME", "BACK", "OK", "UP", "DOWN", "LEFT", "RIGHT", "PLAY_PAUSE"];

    private static readonly FrozenSet<string> KeySet = Keys.ToFrozenSet(StringComparer.Ordinal);

    /// <summary>As ações simples (sem parâmetro), na ordem em que a tela as lista.</summary>
    public static IReadOnlyList<string> Simple { get; } = [PowerOff, VolumeUp, VolumeDown, Mute];

    private static readonly FrozenSet<string> SimpleSet = Simple.ToFrozenSet(StringComparer.Ordinal);

    /// <summary>A tecla do contrato que cada ação de volume aperta.</summary>
    public static string? KeyOf(string code) => code switch
    {
        VolumeUp => "VOLUME_UP",
        VolumeDown => "VOLUME_DOWN",
        Mute => "MUTE",
        _ when code.StartsWith(KeyPrefix, StringComparison.Ordinal) => code[KeyPrefix.Length..],
        _ => null,
    };

    /// <summary>A permissão que a conta precisa ter AGORA para a ação valer (conferida a cada pedido, não só na criação).</summary>
    public static string PermissionOf(string code) => code switch
    {
        PowerOff => AccessPermissions.TvPower,
        _ when code.StartsWith(AppPrefix, StringComparison.Ordinal) => AccessPermissions.TvLaunch,
        _ => AccessPermissions.TvControl,
    };

    public static string KeyCode(string key) => KeyPrefix + key;

    public static string AppCode(Guid shortcutId) => AppPrefix + shortcutId.ToString("D", CultureInfo.InvariantCulture);

    public static bool IsSimple(string code) => SimpleSet.Contains(code);

    public static bool IsKey(string? key) => key is not null && KeySet.Contains(key);

    /// <summary>
    /// O código da ação pedida, ou nulo se o pedido é inválido. <c>power_off</c>, <c>volume_up</c>, <c>volume_down</c> e
    /// <c>mute</c> não levam parâmetro; <c>key</c> exige <paramref name="key"/> da lista; <c>app</c> exige o id.
    /// </summary>
    public static string? CodeOf(string? action, string? key, string? app)
    {
        var name = action?.Trim();
        if (name is null)
        {
            return null;
        }

        if (SimpleSet.Contains(name))
        {
            return key is null && app is null ? name : null;
        }

        if (string.Equals(name, KeyAction, StringComparison.Ordinal))
        {
            return app is null && IsKey(key?.Trim()) ? KeyCode(key!.Trim()) : null;
        }

        if (string.Equals(name, AppAction, StringComparison.Ordinal))
        {
            return key is null && Guid.TryParse(app?.Trim(), out var id) && id != Guid.Empty ? AppCode(id) : null;
        }

        return null;
    }

    /// <summary>O id do atalho de uma ação <c>app:{id}</c>; nulo para as demais.</summary>
    public static Guid? AppIdOf(string code) =>
        code.StartsWith(AppPrefix, StringComparison.Ordinal) && Guid.TryParse(code[AppPrefix.Length..], out var id) ? id : null;

    /// <summary>Uma ação já guardada numa chave é válida? (As de app só têm a forma conferida; o id é conferido contra a TV na criação.)</summary>
    public static bool IsWellFormed(string code) =>
        SimpleSet.Contains(code)
        || (code.StartsWith(KeyPrefix, StringComparison.Ordinal) && IsKey(code[KeyPrefix.Length..]))
        || AppIdOf(code) is not null;
}
