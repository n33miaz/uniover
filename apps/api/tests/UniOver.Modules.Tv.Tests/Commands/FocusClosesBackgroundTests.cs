using System.Text.Json;
using AwesomeAssertions;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Cleanup;
using UniOver.Modules.Tv.Features.Tvs;

namespace UniOver.Modules.Tv.Tests.Commands;

public class FocusClosesBackgroundTests
{
    private const string Light = CleanupSettingsPublisher.LightSettingsCapability;
    private const string Focus = CleanupSettingsPublisher.FocusClosesBackgroundCapability;
    private static readonly DateTimeOffset Now = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);

    private static JsonElement Body(string[] capabilities, bool focusEnabled = true, bool focusCloses = true) =>
        CleanupSettingsPublisher.BuildBody(capabilities, false, focusEnabled, false, "[]", focusCloses, true, true, 700);

    [Fact]
    public void AnAgentWithLightSettingsButWithoutTheNewCapability_DoesNotReceiveTheField()
    {
        var body = Body([CleanupSettingsPublisher.Capability, Light]);

        body.TryGetProperty("focusClosesBackground", out _).Should().BeFalse();
        body.GetProperty("focusEnabled").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public void AnAgentWithoutLightSettings_ReceivesExactlyTheOldBody()
    {
        var body = Body([CleanupSettingsPublisher.Capability]);

        body.EnumerateObject().Select(p => p.Name).Should()
            .BeEquivalentTo("lightEnabled", "deepEnabled", "deepThresholdMb", "closeBackgroundApps");
    }

    [Theory]
    [InlineData(true, true, true)]
    [InlineData(true, false, false)]
    [InlineData(false, true, false)]
    public void AnAgentThatKnowsTheCapability_GetsTheFieldTrueOnlyWithFocusModeAndThePreference(
        bool focusEnabled, bool focusCloses, bool expected)
    {
        var body = Body([Light, Focus], focusEnabled, focusCloses);

        body.GetProperty("focusClosesBackground").GetBoolean().Should().Be(expected);
    }

    private static AgentPresenceInfo Present(params string[] capabilities) =>
        new("pc-sala", true, Now, "2.0.0", capabilities, Now);

    [Fact]
    public void TurningItOn_IsRefusedWhenThePresentAgentDoesNotAnnounceTheCapability()
    {
        var request = new UpdateTvRequest(null, null, FocusModeEnabled: true, FocusClosesBackground: true);

        ManageTvsHandler.IsFocusClosesUnsupported(request, Present(Light)).Should().BeTrue();
        ManageTvsHandler.IsFocusClosesUnsupported(request, Present(Light, Focus)).Should().BeFalse();
    }

    [Fact]
    public void TurningItOffOrLeavingItAlone_IsNeverRefused_AndAnUnknownAgentIsNotRefused()
    {
        var old = Present(Light);

        ManageTvsHandler.IsFocusClosesUnsupported(new UpdateTvRequest(null, null, FocusClosesBackground: false), old)
            .Should().BeFalse();
        ManageTvsHandler.IsFocusClosesUnsupported(new UpdateTvRequest(null, null, FocusModeEnabled: true), old)
            .Should().BeFalse();
        ManageTvsHandler.IsFocusClosesUnsupported(new UpdateTvRequest(null, null, FocusClosesBackground: true), null)
            .Should().BeFalse();
    }

    private const string Catalog = CleanupSettingsPublisher.FocusCatalogCapability;

    [Fact]
    public void TheCatalogOnlyGoesToAnAgentThatAnnouncesIt_AndOnlyWhenTheAdministratorChangedIt()
    {
        const string list = "[\"com.exemplo.cinema\"]";
        JsonElement With(string[] capabilities, string? packages) =>
            CleanupSettingsPublisher.BuildBody(capabilities, false, true, false, "[]", false, true, true, 700, packages);

        With([Light, Focus], list).TryGetProperty("focusPackages", out _).Should().BeFalse("o schema antigo recusaria a mensagem inteira");
        With([Light, Focus, Catalog], null).TryGetProperty("focusPackages", out _).Should().BeFalse("sem lista própria vale a de fábrica");
        With([Light, Focus, Catalog], list).GetProperty("focusPackages").EnumerateArray().Select(p => p.GetString())
            .Should().Equal("com.exemplo.cinema");
        With([CleanupSettingsPublisher.Capability], list).EnumerateObject().Select(p => p.Name).Should()
            .BeEquivalentTo("lightEnabled", "deepEnabled", "deepThresholdMb", "closeBackgroundApps");
    }

    [Fact]
    public void ChangingTheCatalog_IsRefusedWhenThePresentAgentDoesNotAnnounceIt()
    {
        var request = new UpdateTvRequest(null, null, FocusPackages: ["com.exemplo.cinema"]);

        ManageTvsHandler.IsFocusCatalogUnsupported(request, Present(Light, Focus)).Should().BeTrue();
        ManageTvsHandler.IsFocusCatalogUnsupported(request, Present(Light, Focus, Catalog)).Should().BeFalse();
        ManageTvsHandler.IsFocusCatalogUnsupported(request, null).Should().BeFalse("agente que ainda não se apresentou: a lista fica guardada");
        ManageTvsHandler.IsFocusCatalogUnsupported(new UpdateTvRequest(null, null, FocusModeEnabled: true), Present(Light)).Should().BeFalse();
    }

    [Fact]
    public void TheLatestCleanupSummary_IgnoresTheReportsOfTheFocusMode()
    {
        var tv = Guid.NewGuid();
        var otherTv = Guid.NewGuid();
        var cleanup = CleanupReportEntry.Completed(tv, "light", "manual", Now, 900, 300, 600, 2, "[]");
        var focus = CleanupReportEntry.Completed(tv, "light", "focus", Now.AddMinutes(5), 400, null, null, 3, "[]");
        var elsewhere = CleanupReportEntry.Completed(otherTv, "light", "manual", Now.AddMinutes(9), 100, null, null, 1, "[]");

        var latest = CleanupEndpoint.LatestOf(new[] { cleanup, focus, elsewhere }.AsQueryable(), tv)
            .OrderByDescending(r => r.StartedAt).First();

        latest.Should().BeSameAs(cleanup);
        CleanupEndpoint.LatestOf(new[] { focus }.AsQueryable(), tv).Should().BeEmpty();
    }
}
