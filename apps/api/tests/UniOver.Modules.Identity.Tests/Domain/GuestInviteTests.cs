using AwesomeAssertions;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Tests.Domain;

public class GuestInviteTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Validity = TimeSpan.FromHours(48);

    private static GuestInvite NewInvite(string label = "Convidada") =>
        GuestInvite.Create(Guid.NewGuid(), label, SecretTokens.Generate().Hash, Now, Validity);

    [Fact]
    public void Create_StartsPending_AndExpiresAfterTheValidity()
    {
        var invite = NewInvite();

        invite.StatusAt(Now).Should().Be(InviteStatus.Pending);
        invite.StatusAt(Now.AddHours(47)).Should().Be(InviteStatus.Pending);
        invite.ExpiresAt.Should().Be(Now.AddHours(48));
        invite.Role.Should().Be(AccountRoles.Guest);
    }

    [Fact]
    public void StatusAt_ExactlyAtExpiry_IsAlreadyExpired()
    {
        var invite = NewInvite();

        invite.StatusAt(invite.ExpiresAt).Should().Be(InviteStatus.Expired);
        invite.StatusAt(invite.ExpiresAt.AddSeconds(-1)).Should().Be(InviteStatus.Pending);
    }

    [Fact]
    public void Revoke_MakesItRevoked_AndRepeatingIsHarmless()
    {
        var invite = NewInvite();

        invite.Revoke(Now.AddHours(1));
        invite.Revoke(Now.AddHours(2));

        invite.StatusAt(Now.AddHours(3)).Should().Be(InviteStatus.Revoked);
        invite.RevokedAt.Should().Be(Now.AddHours(1), "a primeira revogação é a que vale");
    }

    [Fact]
    public void Revoke_AfterTheExpiry_StillCountsAsRevoked()
    {
        var invite = NewInvite();

        invite.Revoke(Now.AddDays(5));

        invite.StatusAt(Now.AddDays(5)).Should().Be(InviteStatus.Revoked);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("nome\ncom quebra")]
    public void Create_WithoutAUsableName_Throws(string label)
    {
        var act = () => NewInvite(label);

        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void NormalizeLabel_TrimsAndRejectsOverTheLimit()
    {
        GuestInvite.NormalizeLabel("  Alice  ").Should().Be("Alice");
        GuestInvite.NormalizeLabel(new string('a', GuestInvite.LabelMaxLength)).Should().HaveLength(GuestInvite.LabelMaxLength);
        GuestInvite.NormalizeLabel(new string('a', GuestInvite.LabelMaxLength + 1)).Should().BeNull();
        GuestInvite.NormalizeLabel(null).Should().BeNull();
    }

    [Fact]
    public void Create_WithANonPositiveValidity_Throws()
    {
        var act = () => GuestInvite.Create(Guid.NewGuid(), "Alice", SecretTokens.Generate().Hash, Now, TimeSpan.Zero);

        act.Should().Throw<ArgumentOutOfRangeException>();
    }
}

public class InviteSecretTests
{
    [Fact]
    public void Secret_HashesToTheStoredValue_AndATamperedSecretDoesNot()
    {
        var (secret, hash) = SecretTokens.Generate();

        SecretTokens.Hash(secret).Should().Equal(hash);

        // Um caractere trocado (ainda base64url válido) muda o hash; um segredo de outro tamanho nem vira hash.
        var tampered = (secret[0] == 'A' ? 'B' : 'A') + secret[1..];
        SecretTokens.Hash(tampered).Should().NotEqual(hash);
        SecretTokens.Hash(secret + "AA").Should().BeNull();
        SecretTokens.Hash(secret[..^2]).Should().BeNull();
        SecretTokens.Hash("não é base64!").Should().BeNull();
    }

    [Fact]
    public void Secret_IsRandom_AndTheHashIsAllThatIsStored()
    {
        var first = SecretTokens.Generate();
        var second = SecretTokens.Generate();

        first.Secret.Should().NotBe(second.Secret);
        first.Hash.Should().HaveCount(32).And.NotEqual(second.Hash);
    }
}

public class GuestAccountTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Create_IsTheOwner_AndCreateGuestIsAGuest()
    {
        var owner = User.Create("dono@uniover.test", "dono", "hash", Now);
        var guest = User.CreateGuest("  Alice@Uniover.Test ", "Alice", "hash", Now);

        owner.Role.Should().Be(AccountRoles.Owner);
        guest.Role.Should().Be(AccountRoles.Guest);
        guest.Email.Should().Be("alice@uniover.test");
        guest.IsDisabled.Should().BeFalse();
    }

    [Fact]
    public void Disable_RevokesAGuest_ButNeverTheOwner()
    {
        var guest = User.CreateGuest("alice@uniover.test", "Alice", "hash", Now);
        var owner = User.Create("dono@uniover.test", "dono", "hash", Now);

        guest.Disable(Now.AddMinutes(1));
        guest.Disable(Now.AddMinutes(2));
        var act = () => owner.Disable(Now);

        guest.IsDisabled.Should().BeTrue();
        guest.DisabledAt.Should().Be(Now.AddMinutes(1));
        act.Should().Throw<InvalidOperationException>();
        owner.IsDisabled.Should().BeFalse();
    }
}

public class AccountRolesTests
{
    private static System.Security.Claims.ClaimsPrincipal With(params System.Security.Claims.Claim[] claims) =>
        new(new System.Security.Claims.ClaimsIdentity(claims, "teste"));

    [Fact]
    public void Of_ReadsTheRoleClaim()
    {
        AccountRoles.Of(With(new System.Security.Claims.Claim(UniOverAuth.RoleClaim, "guest"))).Should().Be("guest");
        AccountRoles.Of(With(new System.Security.Claims.Claim(UniOverAuth.RoleClaim, "owner"))).Should().Be("owner");
    }

    [Fact]
    public void Of_WithoutTheClaim_IsTheOwner_BecauseOlderTokensCameFromTheOnlyAccountThatExisted()
    {
        AccountRoles.Of(With()).Should().Be("owner");
        AccountRoles.Of(null).Should().Be("owner");
    }

    [Fact]
    public void Of_WithAnUnknownClaim_IsNotPromotedToOwner()
    {
        AccountRoles.Of(With(new System.Security.Claims.Claim(UniOverAuth.RoleClaim, "admin"))).Should().Be("admin");
        AccountRoles.IsKnown("admin").Should().BeFalse();
        AccountRoles.IsKnown("").Should().BeFalse();
        AccountRoles.IsKnown(null).Should().BeFalse();
    }

    [Fact]
    public void TheCodeValuesMatchTheDatabaseConstraintAndTheGeneratedContract()
    {
        AccountRoles.Owner.Should().Be("owner");
        AccountRoles.Guest.Should().Be("guest");
    }
}

public class GuestInviteValidationTests
{
    [Fact]
    public void Validate_AcceptsAGoodRequest()
    {
        var errors = Features.AcceptGuestInvite.AcceptGuestInviteEndpoint.Validate(
            new Features.AcceptGuestInvite.AcceptGuestInviteRequest("token", "alice@uniover.test", "uma-senha-longa"), 10);

        errors.Should().BeEmpty();
    }

    [Fact]
    public void Validate_AppliesTheSamePasswordRuleAsTheOwner_AndNeverEchoesThePassword()
    {
        const string shortPassword = "curta-1";

        var errors = Features.AcceptGuestInvite.AcceptGuestInviteEndpoint.Validate(
            new Features.AcceptGuestInvite.AcceptGuestInviteRequest("token", "alice@uniover.test", shortPassword), 10);

        errors.Should().ContainKey("password");
        errors["password"].Single().Should().Contain("10").And.NotContain(shortPassword);
    }

    [Theory]
    [InlineData(null, "a@b.test", "uma-senha-longa", "token")]
    [InlineData("token", "sem-arroba", "uma-senha-longa", "email")]
    [InlineData("token", "a@b.test", "", "password")]
    public void Validate_FlagsEachMissingField(string? token, string? email, string? password, string expectedField)
    {
        var errors = Features.AcceptGuestInvite.AcceptGuestInviteEndpoint.Validate(
            new Features.AcceptGuestInvite.AcceptGuestInviteRequest(token, email, password), 10);

        errors.Should().ContainKey(expectedField);
    }
}
