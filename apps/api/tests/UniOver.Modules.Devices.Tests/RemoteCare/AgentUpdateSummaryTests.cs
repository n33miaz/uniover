using AwesomeAssertions;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.RemoteCare;

namespace UniOver.Modules.Devices.Tests.RemoteCare;

public sealed class AgentUpdateSummaryTests
{
    private const string Old = "a111111111111111111111111111111111111111";
    private const string New = "b222222222222222222222222222222222222222";

    private static AgentUpdateInfo Info(string outcome, string? installed = Old, string? latest = null, bool rolledBack = false) =>
        new(outcome, installed, null, latest, null, null, null, null, null, rolledBack);

    [Fact]
    public void AnAgentThatNeverToldItsUpdateStateHasNoSummary() =>
        AgentUpdateSummary.From(null).Should().BeNull();

    [Theory]
    [InlineData("updating", Old, New, AgentUpdateSummary.Updating)]
    [InlineData("failed", Old, New, AgentUpdateSummary.Failed)]
    [InlineData("blocked", Old, New, AgentUpdateSummary.Blocked)]
    [InlineData("rolled_back", Old, New, AgentUpdateSummary.RolledBackState)]
    [InlineData("up_to_date", Old, Old, AgentUpdateSummary.Current)]
    [InlineData("updated", New, New, AgentUpdateSummary.Current)]
    [InlineData("up_to_date", Old, New, AgentUpdateSummary.Pending)]
    [InlineData("not_checked", Old, null, AgentUpdateSummary.Unchecked)]
    [InlineData("up_to_date", null, Old, AgentUpdateSummary.Current)]
    public void TheStateSumsUpOutcomeAndTheTwoVersions(string outcome, string? installed, string? latest, string expected) =>
        AgentUpdateSummary.From(Info(outcome, installed, latest))!.State.Should().Be(expected);

    private static readonly DateTimeOffset Deploy = new(2026, 10, 24, 12, 0, 0, TimeSpan.Zero);
    private static readonly PublishedBuild Published = new(New, Deploy);

    private static AgentUpdateInfo Checked(string outcome, DateTimeOffset? at, string? latest = Old) =>
        new(outcome, Old, null, latest, at, null, null, null, null, false);

    [Fact]
    public void WhenTheApiWasPublishedAfterTheLastCheck_AnotherCommitMeansPending()
    {
        var summary = AgentUpdateSummary.From(Checked("up_to_date", Deploy.AddHours(-3)), Published)!;

        summary.State.Should().Be(AgentUpdateSummary.Pending);
        summary.LatestSha.Should().Be(New);
    }

    [Fact]
    public void AnAgentThatNeverChecked_IsPendingWhenTheApiCommitIsAnother()
    {
        var info = Checked("not_checked", null, latest: null);

        AgentUpdateSummary.From(info, Published)!.State.Should().Be(AgentUpdateSummary.Pending);
    }

    [Fact]
    public void AfterACheckLaterThanTheDeploy_OnlyWhatTheAgentSawCounts()
    {
        var summary = AgentUpdateSummary.From(Checked("up_to_date", Deploy.AddMinutes(10)), Published)!;

        summary.State.Should().Be(AgentUpdateSummary.Current, "o agente olhou depois do deploy e viu que está em dia");
        summary.LatestSha.Should().Be(Old);
    }

    [Fact]
    public void TheSameCommitAsInstalled_OrNoApiCommit_IsNeverPending()
    {
        var installedIsPublished = new PublishedBuild(Old, Deploy);

        AgentUpdateSummary.From(Checked("up_to_date", Deploy.AddHours(-3)), installedIsPublished)!.State.Should().Be(AgentUpdateSummary.Current);
        AgentUpdateSummary.From(Checked("up_to_date", Deploy.AddHours(-3)), new PublishedBuild(null, Deploy))!.State.Should().Be(AgentUpdateSummary.Current);
        AgentUpdateSummary.From(Checked("up_to_date", Deploy.AddHours(-3)), new PublishedBuild("curto", Deploy))!.State.Should().Be(AgentUpdateSummary.Current);
    }

    [Theory]
    [InlineData("failed", AgentUpdateSummary.Failed)]
    [InlineData("updating", AgentUpdateSummary.Updating)]
    [InlineData("blocked", AgentUpdateSummary.Blocked)]
    public void WhatTheAgentSaidAboutItsOwnUpdateNeverGetsOverriddenByTheApiCommit(string outcome, string expected) =>
        AgentUpdateSummary.From(Checked(outcome, Deploy.AddHours(-3)), Published)!.State.Should().Be(expected);

    [Fact]
    public void EveryFieldTheAgentToldGoesThroughUntouched()
    {
        var at = new DateTimeOffset(2026, 10, 24, 14, 0, 0, TimeSpan.Zero);
        var info = new AgentUpdateInfo("failed", Old, at, New, at, at, "sem rede", New, Old, true);

        AgentUpdateSummary.From(info).Should().Be(
            new AgentUpdateSummary("failed", Old, at, New, at, at, "sem rede", New, Old, true));
    }
}
