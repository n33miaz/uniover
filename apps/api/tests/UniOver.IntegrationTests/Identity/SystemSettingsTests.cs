using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Identity.Features.SystemSettings;

namespace UniOver.IntegrationTests.Identity;

[Collection(PostgresGroup.Name)]
public sealed class SystemSettingsTests(PostgresFixture postgres)
{
    private const string Route = "/api/v1/identity/system-settings";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task OwnerChangesContact_AndTheNextReadUsesItWithoutRestart()
    {
        await using var app = await PasskeyApp.StartAsync(postgres, new PasskeyAppOptions
        {
            Extra = new Dictionary<string, string?> { ["TRAINING_OFF_CONTACT"] = "server@example.test" },
        });
        var owner = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterAsync(owner, authenticator);

        using var before = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);
        var initial = await PasskeyApp.JsonAsync(before);
        initial.EnumerateArray().Single(item => item.GetProperty("key").GetString() == SystemSettingKeys.OffContact)
            .GetProperty("source").GetString().Should().Be("server");

        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.SystemSettingsChange);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);
        using var saved = await app.SendAsync(HttpMethod.Put, Route + "/" + SystemSettingKeys.OffContact,
            new { value = "app@example.test" }, owner.AccessToken);
        saved.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await PasskeyApp.JsonAsync(saved);
        body.GetProperty("value").GetString().Should().Be("app@example.test");
        body.GetProperty("source").GetString().Should().Be("app");

        using var after = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);
        var changed = await PasskeyApp.JsonAsync(after);
        changed.EnumerateArray().Single(item => item.GetProperty("key").GetString() == SystemSettingKeys.OffContact)
            .GetProperty("value").GetString().Should().Be("app@example.test");
        await using var db = app.Db();
        (await db.LoginAudit.SingleAsync(a => a.Event == AuditEvents.SystemSettingChanged, Ct)).Detail
            .Should().Be(SystemSettingKeys.OffContact);
    }

    [Fact]
    public async Task GuestCannotReadOrChangeSettings()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        using var read = await app.SendAsync(HttpMethod.Get, Route, bearer: guest.Login.AccessToken);
        using var write = await app.SendAsync(HttpMethod.Put, Route + "/" + SystemSettingKeys.MaxComputersPerGuest,
            new { value = 3 }, guest.Login.AccessToken);
        read.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        write.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task InvalidValueIsRejectedWithoutSaving()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterAsync(owner, authenticator);
        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.SystemSettingsChange);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);
        using var response = await app.SendAsync(HttpMethod.Put, Route + "/" + SystemSettingKeys.MaxComputersPerGuest,
            new { value = 0 }, owner.AccessToken);
        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        await using var db = app.Db();
        (await db.SystemSettings.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task OwnerWithoutPasskeyConfirmationCannotSave()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        using var response = await app.SendAsync(HttpMethod.Put, Route + "/" + SystemSettingKeys.MaxComputersPerGuest,
            new { value = 3 }, owner.AccessToken);
        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await PasskeyApp.JsonAsync(response)).GetProperty("code").GetString().Should().Be("step_up_required");
    }

    [Fact]
    public async Task GuestLimitUsesEnvironmentUntilTheOwnerSavesANewValue()
    {
        await using var app = await PasskeyApp.StartAsync(postgres, new PasskeyAppOptions
        {
            Extra = new Dictionary<string, string?> { ["Modules:Devices:Pairing:MaxPerGuest"] = "3" },
        });
        var settings = app.Services.GetRequiredService<ISystemSettings>();
        (await settings.MaxComputersPerGuestAsync(Ct)).Should().Be(3);
        var owner = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterAsync(owner, authenticator);
        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.SystemSettingsChange);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);
        using var response = await app.SendAsync(HttpMethod.Put, Route + "/" + SystemSettingKeys.MaxComputersPerGuest,
            new { value = 4 }, owner.AccessToken);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await settings.MaxComputersPerGuestAsync(Ct)).Should().Be(4);
    }

    [Fact]
    public async Task OwnerCanSaveTheOfflineAgentAlertDelay()
    {
        await using var app = await PasskeyApp.StartAsync(postgres, new PasskeyAppOptions
        {
            Extra = new Dictionary<string, string?> { ["Modules:Devices:Alerts:OfflineMinutes"] = "12" },
        });
        var owner = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterAsync(owner, authenticator);

        using var before = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);
        var initial = await PasskeyApp.JsonAsync(before);
        initial.EnumerateArray().Single(item => item.GetProperty("key").GetString() == SystemSettingKeys.AgentOfflineMinutes)
            .GetProperty("value").GetInt32().Should().Be(12);

        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.SystemSettingsChange);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);
        using var saved = await app.SendAsync(HttpMethod.Put, Route + "/" + SystemSettingKeys.AgentOfflineMinutes,
            new { value = 15 }, owner.AccessToken);
        saved.StatusCode.Should().Be(HttpStatusCode.OK);
        (await PasskeyApp.JsonAsync(saved)).GetProperty("value").GetInt32().Should().Be(15);

        await using var db = app.Db();
        (await db.LoginAudit.SingleAsync(a => a.Event == AuditEvents.SystemSettingChanged, Ct)).Detail
            .Should().Be(SystemSettingKeys.AgentOfflineMinutes);
    }

    [Fact]
    public async Task RetiredCloudPhotoSetting_IsNotListedNorWritableNorResettable_AndItsBucketRouteIsGone()
    {
        const string retiredKey = "training.photo-storage-enabled";
        await using var app = await PasskeyApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterAsync(owner, authenticator);

        using var listed = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);
        (await PasskeyApp.JsonAsync(listed)).EnumerateArray()
            .Select(item => item.GetProperty("key").GetString()).Should().NotContain(retiredKey);

        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.SystemSettingsChange);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);
        using var write = await app.SendAsync(HttpMethod.Put, Route + "/" + retiredKey, new { value = true }, owner.AccessToken);
        write.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        using var reset = await app.SendAsync(HttpMethod.Delete, Route + "/" + retiredKey, bearer: owner.AccessToken);
        reset.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        using var bucket = await app.SendAsync(HttpMethod.Get, Route + "/photo-bucket", bearer: owner.AccessToken);
        bucket.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task TvCleanupSettings_DefaultToEnabledWithASafeMemoryThreshold()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var settings = app.Services.GetRequiredService<ISystemSettings>();

        (await settings.TvLightCleanupEnabledAsync(Ct)).Should().BeTrue();
        (await settings.TvDeepCleanupEnabledAsync(Ct)).Should().BeTrue();
        (await settings.TvDeepCleanupMemoryThresholdMbAsync(Ct)).Should().Be(160);
    }

    [Fact]
    public async Task OwnerReleasesSoonModules_AndEveryAccountReadsThemWithItsPreferences()
    {
        const string preferences = "/api/v1/identity/me/preferences";
        await using var app = await PasskeyApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var owner = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterAsync(owner, authenticator);

        // Por padrão nenhum "em breve" aparece na Início de ninguém.
        using var before = await app.SendAsync(HttpMethod.Get, preferences, bearer: guest.Login.AccessToken);
        (await PasskeyApp.JsonAsync(before)).GetProperty("soonModules").GetArrayLength().Should().Be(0);

        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.SystemSettingsChange);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);
        string[] released = ["health", "backup", "health"];
        using var saved = await app.SendAsync(HttpMethod.Put, Route + "/" + SystemSettingKeys.HomeSoonModules,
            new { value = released }, owner.AccessToken);
        saved.StatusCode.Should().Be(HttpStatusCode.OK);
        (await PasskeyApp.JsonAsync(saved)).GetProperty("value").EnumerateArray().Select(item => item.GetString())
            .Should().Equal("health", "backup");

        foreach (var token in new[] { guest.Login.AccessToken, owner.AccessToken })
        {
            using var after = await app.SendAsync(HttpMethod.Get, preferences, bearer: token);
            after.StatusCode.Should().Be(HttpStatusCode.OK);
            (await PasskeyApp.JsonAsync(after)).GetProperty("soonModules").EnumerateArray().Select(item => item.GetString())
                .Should().Equal("health", "backup");
        }
    }

    [Fact]
    public async Task SoonModulesRejectsWhatIsNotAListOfModuleIds()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterAsync(owner, authenticator);

        string[] upper = ["Health"];
        string[] spaced = ["saude e eventos"];
        object[] number = [7];
        object[] invalid =
        [
            new { value = "health" },
            new { value = upper },
            new { value = spaced },
            new { value = number },
            new { value = Enumerable.Range(0, 21).Select(index => "modulo-" + index).ToArray() },
        ];
        foreach (var body in invalid)
        {
            using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.SystemSettingsChange);
            confirm.StatusCode.Should().Be(HttpStatusCode.OK);
            using var response = await app.SendAsync(HttpMethod.Put, Route + "/" + SystemSettingKeys.HomeSoonModules,
                body, owner.AccessToken);
            response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }

        await using var db = app.Db();
        (await db.SystemSettings.CountAsync(Ct)).Should().Be(0);
    }
}
