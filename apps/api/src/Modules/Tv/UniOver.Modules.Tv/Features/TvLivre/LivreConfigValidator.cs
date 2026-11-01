using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace UniOver.Modules.Tv.Features.TvLivre;

/// <summary>
/// A única conferência da configuração antes de ela ir para a TV: enumerações, cores, ângulo, escurecimento, pacotes e
/// tamanhos, nas mesmas faixas do contrato do launcher (<c>contracts/tv-launcher/config.v1.schema.json</c>) e do que o
/// agente confere de novo. Recusa o pedido inteiro, com uma mensagem por campo; nunca "conserta" o valor.
/// </summary>
internal static partial class LivreConfigValidator
{
    public const int MaxColors = 3;
    public const int MaxItems = 64;
    public const int MaxHidden = 256;
    public const int MaxSleepMinutes = 720;
    public const double MaxDim = 0.8;

    /// <summary>Tamanho máximo do <c>configJson</c> no contrato da mensagem ao agente.</summary>
    public const int MaxConfigJsonLength = 16384;

    public const string MissingSection = "Informe esta seção.";

    private static readonly string[] ClockSizes = ["small", "medium", "large"];
    private static readonly string[] ClockFormats = ["24h", "12h", "auto"];
    private static readonly string[] WallpaperTypes = ["gradient", "solid", "photo"];
    private static readonly string[] AppModes = ["listed", "all"];
    private static readonly string[] IconSizes = ["small", "medium", "large"];
    private static readonly string[] IconLabels = ["always", "focus", "never"];

    private static readonly JsonSerializerOptions StoredOptions = new(JsonSerializerDefaults.Web);

    /// <summary>Nome de pacote Android, o mesmo padrão do contrato (<c>$defs/package</c>) e do agente.</summary>
    [GeneratedRegex(@"^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 250)]
    private static partial Regex PackagePattern();

    [GeneratedRegex(@"^#[0-9A-Fa-f]{6}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 250)]
    private static partial Regex ColorPattern();

    public static bool IsPackage(string? value) =>
        value is { Length: > 0 and <= 255 } && PackagePattern().IsMatch(value);

    /// <summary>Os erros por campo (vazio quando a configuração vale).</summary>
    public static Dictionary<string, string[]> Validate(LivreConfig? config)
    {
        var errors = new Dictionary<string, string[]>();
        if (config is null)
        {
            errors["body"] = ["Envie a configuração."];
            return errors;
        }

        Clock(config.Clock, errors);
        Wallpaper(config.Wallpaper, errors);
        Apps(config.Apps, errors);
        Icons(config.Icons, errors);
        if (config.Builtin is null)
        {
            errors["builtin"] = [MissingSection];
        }

        if (config.Sleep is null)
        {
            errors["sleep"] = [MissingSection];
        }
        else if (config.Sleep.MaxMinutes is < 0 or > MaxSleepMinutes)
        {
            errors["sleep.maxMinutes"] = [$"Use de 0 a {MaxSleepMinutes} minutos."];
        }

        // O limite do corpo do comando: 256 pacotes de nome longo podem passar do que o contrato da mensagem aceita.
        if (errors.Count == 0 && ToLauncherJson(config).Length > MaxConfigJsonLength)
        {
            errors["apps.hidden"] = ["A configuração ficou grande demais; oculte menos apps."];
        }

        return errors;
    }

    /// <summary>
    /// Os pacotes a desativar e a reativar: ao menos um, os dois lados com no máximo 64 nomes válidos e sem repetir, e
    /// nenhum pacote nos dois lados (o pedido seria ambíguo). A conferência de pacote protegido é do agente, que sabe o que
    /// está de fato instalado.
    /// </summary>
    public static Dictionary<string, string[]> ValidateVisibility(AppsVisibilityRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        if (request is null)
        {
            errors["body"] = ["Envie os apps."];
            return errors;
        }

        Packages(request.Disable, MaxItems, "disable", errors);
        Packages(request.Enable, MaxItems, "enable", errors);
        if (errors.Count > 0)
        {
            return errors;
        }

        var disable = request.Disable ?? [];
        var enable = request.Enable ?? [];
        if (disable.Count + enable.Count == 0)
        {
            errors["body"] = ["Escolha ao menos um app."];
        }
        else if (disable.Intersect(enable, StringComparer.Ordinal).Any())
        {
            errors["enable"] = ["Um app não pode ser desativado e reativado ao mesmo tempo."];
        }

        return errors;
    }

    private static void Clock(LivreClock? clock, Dictionary<string, string[]> errors)
    {
        if (clock is null)
        {
            errors["clock"] = [MissingSection];
            return;
        }

        OneOf(clock.Size, ClockSizes, "clock.size", errors);
        OneOf(clock.Format, ClockFormats, "clock.format", errors);
    }

    private static void Wallpaper(LivreWallpaper? wallpaper, Dictionary<string, string[]> errors)
    {
        if (wallpaper is null)
        {
            errors["wallpaper"] = [MissingSection];
            return;
        }

        OneOf(wallpaper.Type, WallpaperTypes, "wallpaper.type", errors);
        if (wallpaper.Colors is not { Count: >= 1 and <= MaxColors } colors
            || colors.Any(color => color is null || !ColorPattern().IsMatch(color)))
        {
            errors["wallpaper.colors"] = [$"Use de 1 a {MaxColors} cores no formato #RRGGBB."];
        }

        if (wallpaper.Angle is < 0 or > 315 || wallpaper.Angle % 45 != 0)
        {
            errors["wallpaper.angle"] = ["Use um múltiplo de 45 de 0 a 315."];
        }

        // NaN e infinito falham nas duas comparações; o escurecimento nunca é negativo e passa de 0,8 só ilegível.
        if (!(wallpaper.Dim >= 0 && wallpaper.Dim <= MaxDim))
        {
            errors["wallpaper.dim"] = ["Use um valor de 0 a 0,8."];
        }
    }

    private static void Apps(LivreApps? apps, Dictionary<string, string[]> errors)
    {
        if (apps is null)
        {
            errors["apps"] = [MissingSection];
            return;
        }

        OneOf(apps.Mode, AppModes, "apps.mode", errors);
        Packages(apps.Items, MaxItems, "apps.items", errors);
        Packages(apps.Hidden, MaxHidden, "apps.hidden", errors);
    }

    private static void Packages(IReadOnlyList<string>? values, int limit, string field, Dictionary<string, string[]> errors)
    {
        // Lista ausente vale vazia: é o "nenhum", e o contrato aceita.
        if (values is null)
        {
            return;
        }

        if (values.Count > limit)
        {
            errors[field] = [$"Use até {limit} apps."];
        }
        else if (values.Any(value => !IsPackage(value)))
        {
            errors[field] = ["Há um nome de app inválido."];
        }
        else if (values.Distinct(StringComparer.Ordinal).Count() != values.Count)
        {
            errors[field] = ["Há um app repetido."];
        }
    }

    private static void Icons(LivreIcons? icons, Dictionary<string, string[]> errors)
    {
        if (icons is null)
        {
            errors["icons"] = [MissingSection];
            return;
        }

        OneOf(icons.Size, IconSizes, "icons.size", errors);
        OneOf(icons.Labels, IconLabels, "icons.labels", errors);
    }

    private static void OneOf(string? value, string[] allowed, string field, Dictionary<string, string[]> errors)
    {
        if (value is null || !allowed.Contains(value, StringComparer.Ordinal))
        {
            errors[field] = [$"Use um destes valores: {string.Join(", ", allowed)}."];
        }
    }

    /// <summary>
    /// O <c>configJson</c> do contrato do launcher: as seis seções, sem <c>schema</c> (o agente o acrescenta), sem
    /// <c>revision</c> (vai no corpo da mensagem) e sem o nome da foto (o agente o escolhe). Só para configuração já
    /// validada. A ordem dos campos é fixa, para o mesmo conteúdo dar sempre o mesmo texto.
    /// </summary>
    public static string ToLauncherJson(LivreConfig config)
    {
        ArgumentNullException.ThrowIfNull(config);
        var clock = config.Clock;
        var wallpaper = config.Wallpaper;
        var apps = config.Apps;
        var icons = config.Icons;
        var builtin = config.Builtin;

        var document = new JsonObject
        {
            ["clock"] = new JsonObject
            {
                ["enabled"] = clock.Enabled,
                ["size"] = clock.Size,
                ["format"] = clock.Format,
                ["seconds"] = clock.Seconds,
                ["date"] = clock.Date,
            },
            ["wallpaper"] = new JsonObject
            {
                ["type"] = wallpaper.Type,
                ["colors"] = Strings(wallpaper.Colors),
                ["angle"] = wallpaper.Angle,
                ["dim"] = wallpaper.Dim,
            },
            ["apps"] = new JsonObject
            {
                ["mode"] = apps.Mode,
                ["items"] = Strings(apps.Items),
                ["hidden"] = Strings(apps.Hidden),
                ["showFactory"] = apps.ShowFactory,
            },
            ["icons"] = new JsonObject { ["size"] = icons.Size, ["labels"] = icons.Labels },
            ["builtin"] = new JsonObject { ["settings"] = builtin.Settings, ["sleep"] = builtin.Sleep },
            ["sleep"] = new JsonObject { ["maxMinutes"] = config.Sleep.MaxMinutes },
        };
        return document.ToJsonString();
    }

    private static JsonArray Strings(IReadOnlyList<string>? values) =>
        new([.. (values ?? []).Select(value => (JsonNode)JsonValue.Create(value)!)]);

    /// <summary>
    /// A configuração como se guarda: as listas de apps que o cliente omitiu viram listas vazias, para quem lê (a tela) não
    /// precisar tratar "sem lista" e "lista vazia" como duas coisas. Só para configuração já validada.
    /// </summary>
    public static LivreConfig Normalize(LivreConfig config)
    {
        ArgumentNullException.ThrowIfNull(config);
        return config with
        {
            Apps = config.Apps with { Items = config.Apps.Items ?? [], Hidden = config.Apps.Hidden ?? [] },
        };
    }

    /// <summary>A configuração como fica guardada no banco (a mesma forma que a tela envia e recebe).</summary>
    public static string Serialize(LivreConfig config) => JsonSerializer.Serialize(config, StoredOptions);

    /// <summary>Lê a configuração guardada; a ilegível (nunca deveria existir) vira o padrão em vez de derrubar a tela.</summary>
    public static LivreConfig Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return LivreConfig.Default;
        }

        try
        {
            var config = JsonSerializer.Deserialize<LivreConfig>(json, StoredOptions);
            return Validate(config).Count == 0 ? config! : LivreConfig.Default;
        }
        catch (JsonException)
        {
            return LivreConfig.Default;
        }
    }
}
