using AwesomeAssertions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Tests.Passkeys;

public sealed class StepUpRulesTests
{
    [Theory]
    [InlineData("tv.power-off")]
    [InlineData("devices.pair-approve")]
    [InlineData("identity.password-change")]
    [InlineData("a")]
    [InlineData("a1.b2-c3")]
    [InlineData("0")]
    public void ValidActions_AreAccepted(string action) => StepUp.IsValidAction(action).Should().BeTrue();

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("Tv.Power")]
    [InlineData("tv power")]
    [InlineData("tv_power")]
    [InlineData(".tv")]
    [InlineData("tv.")]
    [InlineData("-tv")]
    [InlineData("tv..off")]
    [InlineData("tv.-off")]
    [InlineData("tv.off\n")]
    [InlineData("ação")]
    public void InvalidActions_AreRejected(string? action) => StepUp.IsValidAction(action).Should().BeFalse();

    [Fact]
    public void ActionLimit_Is64Characters()
    {
        StepUp.IsValidAction(new string('a', 64)).Should().BeTrue();
        StepUp.IsValidAction(new string('a', 65)).Should().BeFalse();
    }

    [Fact]
    public void Policy_PrefixesTheActionAndRejectsAnInvalidOne()
    {
        StepUp.Policy("tv.power-off").Should().Be("stepup:tv.power-off");

        var act = () => StepUp.Policy("Tv Power");

        act.Should().Throw<ArgumentException>("uma rota com nome inválido nunca liberaria e passaria despercebida");
    }

    [Fact]
    public void TryGetAction_OnlyRecognisesStepUpPolicies()
    {
        StepUp.TryGetAction("stepup:tv.power-off", out var action).Should().BeTrue();
        action.Should().Be("tv.power-off");
        StepUp.TryGetAction("StreamAccess", out _).Should().BeFalse();
        StepUp.TryGetAction("stepup:INVALIDA", out _).Should().BeFalse();
        StepUp.TryGetAction(null, out _).Should().BeFalse();
    }

    [Fact]
    public async Task PolicyProvider_BuildsTheRequirement_AndKeepsTheDefaultAndFallbackPolicies()
    {
        var authorization = new AuthorizationOptions();
        authorization.AddPolicy("existente", p => p.RequireAuthenticatedUser());
        authorization.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build();
        var provider = new StepUpPolicyProvider(Options.Create(authorization));

        var stepUp = await provider.GetPolicyAsync(StepUp.Policy("tv.power-off"));
        var existing = await provider.GetPolicyAsync("existente");
        var unknown = await provider.GetPolicyAsync("nao-existe");
        var fallback = await provider.GetFallbackPolicyAsync();
        var defaultPolicy = await provider.GetDefaultPolicyAsync();

        stepUp!.Requirements.OfType<StepUpRequirement>().Should().ContainSingle().Which.Action.Should().Be("tv.power-off");
        existing.Should().NotBeNull();
        unknown.Should().BeNull();
        fallback.Should().NotBeNull("a regra de autenticado por padrão não pode sumir");
        defaultPolicy.Should().NotBeNull();
    }

    [Fact]
    public void Confirmation_IsValidOnlyBeforeItsExpiry()
    {
        var now = new DateTimeOffset(2026, 10, 18, 12, 0, 0, TimeSpan.Zero);
        var confirmation = StepUpConfirmation.Create(Guid.NewGuid(), Guid.NewGuid(), "tv.power-off", now, TimeSpan.FromMinutes(5));

        confirmation.ExpiresAt.Should().Be(now.AddMinutes(5));
        confirmation.IsValidAt(now).Should().BeTrue();
        confirmation.IsValidAt(now.AddMinutes(5) - TimeSpan.FromTicks(1)).Should().BeTrue();
        confirmation.IsValidAt(now.AddMinutes(5)).Should().BeFalse();
        confirmation.IsValidAt(now.AddHours(1)).Should().BeFalse();
    }

    [Fact]
    public void Confirmation_NeedsAPositiveWindow()
    {
        var act = () => StepUpConfirmation.Create(Guid.NewGuid(), Guid.NewGuid(), "a", DateTimeOffset.UnixEpoch, TimeSpan.Zero);

        act.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public void Challenge_LastsTwoMinutes()
    {
        var now = new DateTimeOffset(2026, 10, 18, 12, 0, 0, TimeSpan.Zero);

        var challenge = WebAuthnChallenge.Create(Guid.NewGuid(), ChallengePurposes.StepUp, "tv.power-off", "{}", now);

        challenge.ExpiresAt.Should().Be(now.AddMinutes(2));
    }

    [Fact]
    public void Options_DefaultToFiveMinutes_AndRejectOutOfRangeValues()
    {
        new StepUpOptions().Validity.Should().Be(TimeSpan.FromMinutes(5));
        StepUpOptions.IsValid(new StepUpOptions { Minutes = 0 }).Should().BeFalse();
        StepUpOptions.IsValid(new StepUpOptions { Minutes = 61 }).Should().BeFalse();
        StepUpOptions.IsValid(new StepUpOptions { Minutes = 1 }).Should().BeTrue();
    }
}

public sealed class PasskeyRulesTests
{
    [Theory]
    [InlineData(1, false)]
    [InlineData(0, false)]
    [InlineData(2, true)]
    [InlineData(5, true)]
    public void LastPasskey_CannotBeRemoved(int count, bool allowed) => PasskeyRules.CanRemove(count).Should().Be(allowed);

    [Theory]
    [InlineData(0, 0, true)]
    [InlineData(0, 1, true)]
    [InlineData(5, 6, true)]
    [InlineData(5, 5, false)]
    [InlineData(5, 4, false)]
    [InlineData(5, 0, false)]
    public void SignCount_MustGrow_OrStayZeroForAuthenticatorsThatDoNotCount(long stored, long received, bool accepted) =>
        PasskeyRules.SignCountAdvances(stored, received).Should().Be(accepted);

    [Fact]
    public void Name_IsTrimmedAndBounded()
    {
        PasskeyRules.NormalizeName("  iPhone  ").Should().Be("iPhone");
        PasskeyRules.NormalizeName(null).Should().BeNull();
        PasskeyRules.NormalizeName("   ").Should().BeNull();
        PasskeyRules.NormalizeName(new string('a', PasskeyRules.MaxNameLength)).Should().NotBeNull();
        PasskeyRules.NormalizeName(new string('a', PasskeyRules.MaxNameLength + 1)).Should().BeNull();
    }

    [Fact]
    public void RegisterUse_UpdatesCounterAndLastUse()
    {
        var now = new DateTimeOffset(2026, 10, 18, 12, 0, 0, TimeSpan.Zero);
        var passkey = Passkey.Create(Guid.NewGuid(), [1], [2], 0, Guid.Empty, "Chave", null, now);

        passkey.RegisterUse(3, now.AddMinutes(1));

        passkey.SignCount.Should().Be(3);
        passkey.LastUsedAt.Should().Be(now.AddMinutes(1));
    }
}
