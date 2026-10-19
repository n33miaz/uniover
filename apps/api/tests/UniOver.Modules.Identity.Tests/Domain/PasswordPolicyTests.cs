using AwesomeAssertions;
using UniOver.Modules.Identity.Domain;

namespace UniOver.Modules.Identity.Tests.Domain;

public class PasswordPolicyTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void Validate_RequiresAPassword(string? password)
    {
        PasswordPolicy.Validate(password).Should().Equal("password-required");
    }

    [Theory]
    [InlineData("123456789", false)]
    [InlineData("1234567890", true)]
    [InlineData("uma senha longa o bastante", true)]
    public void Validate_RequiresAtLeastTenCharacters(string password, bool accepted)
    {
        PasswordPolicy.Validate(password).Count.Should().Be(accepted ? 0 : 1);
    }

    [Fact]
    public void Validate_HasNoCompositionRule()
    {
        // Só o tamanho conta: nada de maiúscula, dígito ou símbolo obrigatórios.
        PasswordPolicy.Validate("aaaaaaaaaa").Should().BeEmpty();
    }

    [Fact]
    public void Validate_UsesTheConfiguredMinimum()
    {
        PasswordPolicy.Validate("12345678901", minimumLength: 12).Should().Equal("password-too-short");
    }

    [Fact]
    public void Validate_RejectsHugeInput_WithoutEchoingIt()
    {
        var errors = PasswordPolicy.Validate(new string('x', PasswordPolicy.MaximumLength + 1));

        errors.Should().Equal("password-too-long");
    }
}

public class EmailRulesTests
{
    [Theory]
    [InlineData("dono@uniover.test", true)]
    [InlineData("a@b", true)]
    [InlineData("sem-arroba", false)]
    [InlineData("@x.com", false)]
    [InlineData("x@", false)]
    [InlineData("a@@b.com", false)]
    [InlineData("a b@c.com", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void IsValid_ChecksOnlyTheBasicShape(string? email, bool expected)
    {
        EmailRules.IsValid(email).Should().Be(expected);
    }

    [Fact]
    public void IsValid_RejectsAnAddressLongerThan254()
    {
        EmailRules.IsValid(new string('a', 250) + "@b.co").Should().BeFalse();
    }

    [Fact]
    public void Normalize_TrimsAndLowercases()
    {
        EmailRules.Normalize("  Dono@UniOver.Test ").Should().Be("dono@uniover.test");
    }
}
