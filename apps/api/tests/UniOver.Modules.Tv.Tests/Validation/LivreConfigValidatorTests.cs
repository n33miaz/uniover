using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Json.Schema;
using UniOver.Modules.Tv.Features.TvLivre;

namespace UniOver.Modules.Tv.Tests.Validation;

public class LivreConfigValidatorTests
{
    private static readonly JsonSerializerOptions BodyOptions = new(JsonSerializerDefaults.Web);

    private static LivreConfig Valid => LivreConfig.Default;

    private static Dictionary<string, string[]> Check(LivreConfig config) => LivreConfigValidator.Validate(config);

    private static string[] Packages(int count, int length = 20) =>
        [.. Enumerable.Range(0, count).Select(i => $"app.p{i}{new string('x', Math.Max(0, length - 8))}")];

    // ---- o padrão e o que vale ----

    [Fact]
    public void TheDefault_IsValid_AndUsesAllWithTheFactoryAppsHidden()
    {
        Check(Valid).Should().BeEmpty();
        // 'listed' com lista vazia mostraria TODOS os apps no launcher; o padrão do dono é 'all' sem os de fábrica.
        Valid.Apps!.Mode.Should().Be("all");
        Valid.Apps.Items.Should().BeEmpty();
        Valid.Apps.ShowFactory.Should().BeFalse();
        Valid.Clock!.Size.Should().Be("large");
        Valid.Clock.Format.Should().Be("24h");
        Valid.Wallpaper!.Colors.Should().Equal("#1B2440", "#3A2D5C");
        Valid.Wallpaper.Angle.Should().Be(315);
        Valid.Wallpaper.Dim.Should().Be(0.25);
    }

    [Theory]
    [InlineData("small")]
    [InlineData("medium")]
    [InlineData("large")]
    public void EveryClockSize_IsAccepted(string size) =>
        Check(Valid with { Clock = Valid.Clock! with { Size = size } }).Should().BeEmpty();

    [Theory]
    [InlineData("24h")]
    [InlineData("12h")]
    [InlineData("auto")]
    public void EveryClockFormat_IsAccepted(string format) =>
        Check(Valid with { Clock = Valid.Clock! with { Format = format } }).Should().BeEmpty();

    [Theory]
    [InlineData(0)]
    [InlineData(45)]
    [InlineData(270)]
    [InlineData(315)]
    public void AnAngleThatIsAMultipleOf45UpTo315_IsAccepted(int angle) =>
        Check(Valid with { Wallpaper = Valid.Wallpaper! with { Angle = angle } }).Should().BeEmpty();

    [Theory]
    [InlineData(0.0)]
    [InlineData(0.8)]
    public void TheDimLimits_AreInclusive(double dim) =>
        Check(Valid with { Wallpaper = Valid.Wallpaper! with { Dim = dim } }).Should().BeEmpty();

    // ---- o que se recusa ----

    [Theory]
    [InlineData("huge")]
    [InlineData("LARGE")]
    [InlineData("")]
    [InlineData(null)]
    public void AnUnknownClockSize_IsRefused(string? size) =>
        Check(Valid with { Clock = Valid.Clock! with { Size = size! } }).Should().ContainKey("clock.size");

    [Fact]
    public void AnUnknownClockFormat_IsRefused() =>
        Check(Valid with { Clock = Valid.Clock! with { Format = "36h" } }).Should().ContainKey("clock.format");

    [Fact]
    public void AnUnknownWallpaperType_IsRefused() =>
        Check(Valid with { Wallpaper = Valid.Wallpaper! with { Type = "video" } }).Should().ContainKey("wallpaper.type");

    [Fact]
    public void AnUnknownAppsMode_IsRefused() =>
        Check(Valid with { Apps = Valid.Apps! with { Mode = "some" } }).Should().ContainKey("apps.mode");

    [Fact]
    public void UnknownIconSizeAndLabels_AreRefused()
    {
        Check(Valid with { Icons = Valid.Icons! with { Size = "giant" } }).Should().ContainKey("icons.size");
        Check(Valid with { Icons = Valid.Icons! with { Labels = "sometimes" } }).Should().ContainKey("icons.labels");
    }

    [Theory]
    [InlineData("#12345")]
    [InlineData("#1234567")]
    [InlineData("123456")]
    [InlineData("#GGGGGG")]
    [InlineData("red")]
    [InlineData("#12 456")]
    public void AColorThatIsNotRRGGBB_IsRefused(string color) =>
        Check(Valid with { Wallpaper = Valid.Wallpaper! with { Colors = [color] } }).Should().ContainKey("wallpaper.colors");

    [Fact]
    public void LowercaseHexColors_AreAccepted() =>
        Check(Valid with { Wallpaper = Valid.Wallpaper! with { Colors = ["#aabbcc"] } }).Should().BeEmpty();

    [Fact]
    public void BetweenOneAndThreeColors_AreRequired()
    {
        Check(Valid with { Wallpaper = Valid.Wallpaper! with { Colors = [] } }).Should().ContainKey("wallpaper.colors");
        Check(Valid with { Wallpaper = Valid.Wallpaper! with { Colors = null } }).Should().ContainKey("wallpaper.colors");
        Check(Valid with { Wallpaper = Valid.Wallpaper! with { Colors = ["#111111", "#222222", "#333333", "#444444"] } })
            .Should().ContainKey("wallpaper.colors");
        Check(Valid with { Wallpaper = Valid.Wallpaper! with { Colors = ["#111111", "#222222", "#333333"] } }).Should().BeEmpty();
    }

    [Theory]
    [InlineData(-45)]
    [InlineData(44)]
    [InlineData(360)]
    [InlineData(90 + 1)]
    public void AnAngleOutsideTheMultiplesOf45Up315_IsRefused(int angle) =>
        Check(Valid with { Wallpaper = Valid.Wallpaper! with { Angle = angle } }).Should().ContainKey("wallpaper.angle");

    [Theory]
    [InlineData(-0.01)]
    [InlineData(0.81)]
    [InlineData(1.0)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    public void ADimOutsideZeroToPoint8_IsRefused(double dim) =>
        Check(Valid with { Wallpaper = Valid.Wallpaper! with { Dim = dim } }).Should().ContainKey("wallpaper.dim");

    [Theory]
    [InlineData("com")]
    [InlineData("1app.example")]
    [InlineData("com.exemplo app")]
    [InlineData("com..exemplo")]
    [InlineData("com.exemplo;rm")]
    [InlineData("")]
    public void APackageNameOutsideThePattern_IsRefused(string package)
    {
        Check(Valid with { Apps = Valid.Apps! with { Items = [package] } }).Should().ContainKey("apps.items");
        Check(Valid with { Apps = Valid.Apps! with { Hidden = [package] } }).Should().ContainKey("apps.hidden");
    }

    [Fact]
    public void APackageNameLongerThan255_IsRefused() =>
        Check(Valid with { Apps = Valid.Apps! with { Items = ["a." + new string('b', 254)] } }).Should().ContainKey("apps.items");

    [Fact]
    public void APackageListWithADuplicate_IsRefused() =>
        Check(Valid with { Apps = Valid.Apps! with { Items = ["com.a.b", "com.a.b"] } }).Should().ContainKey("apps.items");

    [Fact]
    public void TheItemsLimitIs64_AndTheHiddenLimitIs256()
    {
        Check(Valid with { Apps = Valid.Apps! with { Items = Packages(64) } }).Should().BeEmpty();
        Check(Valid with { Apps = Valid.Apps! with { Items = Packages(65) } }).Should().ContainKey("apps.items");
        Check(Valid with { Apps = Valid.Apps! with { Hidden = Packages(256) } }).Should().BeEmpty();
        Check(Valid with { Apps = Valid.Apps! with { Hidden = Packages(257) } }).Should().ContainKey("apps.hidden");
    }

    [Theory]
    [InlineData(0)]
    [InlineData(720)]
    public void TheSleepMinutesLimits_AreInclusive(int minutes) =>
        Check(Valid with { Sleep = new LivreSleep(minutes) }).Should().BeEmpty();

    [Theory]
    [InlineData(-1)]
    [InlineData(721)]
    public void SleepMinutesOutsideZeroTo720_AreRefused(int minutes) =>
        Check(Valid with { Sleep = new LivreSleep(minutes) }).Should().ContainKey("sleep.maxMinutes");

    [Fact]
    public void AMissingSection_IsRefusedByName()
    {
        var errors = Check(new LivreConfig(null!, null!, null!, null!, null!, null!));

        errors.Keys.Should().BeEquivalentTo("clock", "wallpaper", "apps", "icons", "builtin", "sleep");
    }

    [Fact]
    public void ANullBody_IsRefused() => Check(null!).Should().ContainKey("body");

    [Fact]
    public void ManyLongHiddenPackages_ThatWouldOverflowTheCommandBody_AreRefused()
    {
        // 256 nomes de 250 caracteres passam nos limites de cada campo, mas o corpo do comando aceita 16384 caracteres.
        var hidden = Packages(256, 250);
        hidden.Should().OnlyContain(p => LivreConfigValidator.IsPackage(p));

        Check(Valid with { Apps = Valid.Apps! with { Hidden = hidden } }).Should().ContainKey("apps.hidden");
    }

    [Fact]
    public void SeveralErrors_AreReportedTogether()
    {
        var errors = Check(Valid with
        {
            Clock = Valid.Clock! with { Size = "x" },
            Wallpaper = Valid.Wallpaper! with { Angle = 1, Dim = 5 },
        });

        errors.Keys.Should().BeEquivalentTo("clock.size", "wallpaper.angle", "wallpaper.dim");
    }

    // ---- o configJson do contrato do launcher ----

    [Fact]
    public void TheLauncherJson_OfTheDefault_IsExactlyTheSixSectionsInAFixedOrder()
    {
        LivreConfigValidator.ToLauncherJson(Valid).Should().Be(
            "{\"clock\":{\"enabled\":true,\"size\":\"large\",\"format\":\"24h\",\"seconds\":false,\"date\":true},"
            + "\"wallpaper\":{\"type\":\"gradient\",\"colors\":[\"#1B2440\",\"#3A2D5C\"],\"angle\":315,\"dim\":0.25},"
            + "\"apps\":{\"mode\":\"all\",\"items\":[],\"hidden\":[],\"showFactory\":false},"
            + "\"icons\":{\"size\":\"medium\",\"labels\":\"always\"},"
            + "\"builtin\":{\"settings\":true,\"sleep\":false},"
            + "\"sleep\":{\"maxMinutes\":0}}");
    }

    [Fact]
    public void TheLauncherJson_NeverCarriesSchemaRevisionOrThePhotoName()
    {
        var config = Valid with { Wallpaper = Valid.Wallpaper! with { Type = "photo" } };

        var document = JsonNode.Parse(LivreConfigValidator.ToLauncherJson(config))!.AsObject();

        document.Select(p => p.Key).Should().NotContain(["schema", "revision"]);
        document["wallpaper"]!.AsObject().Select(p => p.Key).Should().NotContain("photo");
    }

    [Fact]
    public void TheLauncherJson_ComesOutTheSame_ForTheSameConfig()
    {
        var config = Valid with { Apps = Valid.Apps! with { Items = ["com.a.b", "com.c.d"], Hidden = ["com.x.y"] } };

        LivreConfigValidator.ToLauncherJson(config).Should().Be(LivreConfigValidator.ToLauncherJson(config with { }));
    }

    [Fact]
    public void TheLauncherJson_FollowsTheLauncherContractSchema()
    {
        var schema = LoadLauncherSchema();
        var config = new LivreConfig(
            new LivreClock(true, "small", "auto", true, false),
            new LivreWallpaper("photo", ["#000000", "#ffffff", "#123ABC"], 45, 0.8),
            new LivreApps("listed", ["com.exemplo.a", "com.exemplo.b"], ["com.exemplo.c"], true),
            new LivreIcons("large", "focus"),
            new LivreBuiltin(false, true),
            new LivreSleep(720));
        Check(config).Should().BeEmpty();

        // O agente acrescenta schema e revision (e o nome da foto) antes de gravar o arquivo na TV; com eles o
        // documento precisa passar no contrato.
        var document = JsonNode.Parse(LivreConfigValidator.ToLauncherJson(config))!.AsObject();
        document["schema"] = 1;
        document["revision"] = 7;
        document["wallpaper"]!["photo"] = "wallpaper.jpg";

        IsValid(schema, document)
            .Should().BeTrue("a configuração que a API monta segue o contrato do launcher");
    }

    [Fact]
    public void TheDefaultLauncherJson_FollowsTheLauncherContractSchema()
    {
        var schema = LoadLauncherSchema();
        var document = JsonNode.Parse(LivreConfigValidator.ToLauncherJson(Valid))!.AsObject();
        document["schema"] = 1;
        document["revision"] = 1;

        IsValid(schema, document).Should().BeTrue();
    }

    // ---- guardada e relida ----

    [Fact]
    public void Normalize_TurnsOmittedAppLists_IntoEmptyOnes_AndKeepsTheRest()
    {
        var sparse = Valid with { Apps = new LivreApps("listed", null, null, true) };

        var normalized = LivreConfigValidator.Normalize(sparse);

        normalized.Apps.Items.Should().NotBeNull().And.BeEmpty();
        normalized.Apps.Hidden.Should().NotBeNull().And.BeEmpty();
        normalized.Apps.Mode.Should().Be("listed");
        normalized.Apps.ShowFactory.Should().BeTrue();
        normalized.Clock.Should().BeSameAs(sparse.Clock);
    }

    [Fact]
    public void AStoredConfig_ComesBackEqual()
    {
        var config = Valid with { Apps = Valid.Apps! with { Items = ["com.a.b"], Hidden = ["com.c.d"] }, Sleep = new LivreSleep(30) };

        var back = LivreConfigValidator.Parse(LivreConfigValidator.Serialize(config));

        back.Apps!.Items.Should().Equal("com.a.b");
        back.Apps.Hidden.Should().Equal("com.c.d");
        back.Sleep!.MaxMinutes.Should().Be(30);
        back.Wallpaper!.Colors.Should().Equal(config.Wallpaper!.Colors!);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("não é json")]
    [InlineData("{\"clock\":{\"size\":\"enorme\"}}")]
    public void ANothingOrUnreadableStoredConfig_BecomesTheDefault(string? stored) =>
        LivreConfigValidator.Parse(stored).Should().BeSameAs(LivreConfig.Default);

    [Fact]
    public void TheBodyJson_RefusesAnUnknownField()
    {
        var json = "{\"clock\":{\"enabled\":true,\"size\":\"large\",\"format\":\"24h\",\"seconds\":false,\"date\":true,\"extra\":1}}";

        var act = () => JsonSerializer.Deserialize<LivreConfig>(json, BodyOptions);

        act.Should().Throw<JsonException>();
    }

    [Fact]
    public void TheBodyJson_RefusesANumberWrittenAsText()
    {
        var json = "{\"sleep\":{\"maxMinutes\":\"30\"}}";

        var act = () => JsonSerializer.Deserialize<LivreConfig>(json, BodyOptions);

        act.Should().Throw<JsonException>();
    }

    // ---- visibilidade dos apps ----

    [Fact]
    public void Visibility_AcceptsDisableAndEnable_WithoutOverlap() =>
        LivreConfigValidator.ValidateVisibility(new AppsVisibilityRequest(["com.a.b"], ["com.c.d"])).Should().BeEmpty();

    [Fact]
    public void Visibility_RefusesNothingToDo()
    {
        LivreConfigValidator.ValidateVisibility(new AppsVisibilityRequest([], [])).Should().ContainKey("body");
        LivreConfigValidator.ValidateVisibility(new AppsVisibilityRequest()).Should().ContainKey("body");
        LivreConfigValidator.ValidateVisibility(null).Should().ContainKey("body");
    }

    [Fact]
    public void Visibility_RefusesAPackageOnBothSides() =>
        LivreConfigValidator.ValidateVisibility(new AppsVisibilityRequest(["com.a.b"], ["com.a.b"])).Should().ContainKey("enable");

    [Fact]
    public void Visibility_RefusesInvalidDuplicateAndTooManyPackages()
    {
        LivreConfigValidator.ValidateVisibility(new AppsVisibilityRequest(["nome ruim"], null)).Should().ContainKey("disable");
        LivreConfigValidator.ValidateVisibility(new AppsVisibilityRequest(null, ["com.a.b", "com.a.b"])).Should().ContainKey("enable");
        LivreConfigValidator.ValidateVisibility(new AppsVisibilityRequest(Packages(65), null)).Should().ContainKey("disable");
        LivreConfigValidator.ValidateVisibility(new AppsVisibilityRequest(Packages(64), null)).Should().BeEmpty();
    }

    /// <summary>
    /// Cada teste carrega o esquema num registro próprio: o registro global recusa o mesmo <c>$id</c> duas vezes.
    /// </summary>
    private static JsonSchema LoadLauncherSchema() => JsonSchema.FromText(
        File.ReadAllText(ContractPath("tv-launcher", "config.v1.schema.json")),
        new BuildOptions { SchemaRegistry = new SchemaRegistry() });

    private static bool IsValid(JsonSchema schema, JsonNode document)
    {
        using var parsed = JsonDocument.Parse(document.ToJsonString());
        return schema.Evaluate(parsed.RootElement).IsValid;
    }

    /// <summary>O contrato fica na raiz do repositório; sobe a partir da pasta dos binários até achar <c>contracts</c>.</summary>
    internal static string ContractPath(params string[] parts)
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "contracts", "tv-launcher")))
            {
                return Path.Combine([dir.FullName, "contracts", .. parts]);
            }
        }

        throw new DirectoryNotFoundException("A pasta contracts não foi encontrada acima dos binários do teste.");
    }
}
