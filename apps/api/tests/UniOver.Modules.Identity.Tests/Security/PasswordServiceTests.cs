using AwesomeAssertions;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Tests.Security;

public class PasswordServiceTests
{
    private static readonly PasswordService Passwords = new();

    private static User UserWith(string hash) => User.Create("dono@uniover.test", "dono", hash, DateTimeOffset.UnixEpoch);

    [Fact]
    public void HashThenVerify_AcceptsTheRightPasswordOnly()
    {
        var hash = Passwords.Hash("uma-senha-de-teste");
        var user = UserWith(hash);

        Passwords.Verify(user, "uma-senha-de-teste").Should().Be(PasswordCheck.Success);
        Passwords.Verify(user, "outra-senha-de-teste").Should().Be(PasswordCheck.Failed);
        hash.Should().NotContain("uma-senha-de-teste");
    }

    [Fact]
    public void Hash_IsSalted()
    {
        Passwords.Hash("mesma-senha-123").Should().NotBe(Passwords.Hash("mesma-senha-123"));
    }

    [Fact]
    public void Verify_WithoutAUser_AlwaysFails()
    {
        // O hash fictício existe para igualar o tempo de resposta do e-mail inexistente ao do e-mail com senha
        // errada. A igualdade de tempo não é afirmada aqui: comparar relógio de parede em teste é fonte de falha
        // intermitente. O que se prova é que, sem usuário, nenhuma senha passa, nem a que o hasher gerou.
        Passwords.Verify(null, "errada").Should().Be(PasswordCheck.Failed);
        Passwords.Verify(null, string.Empty).Should().Be(PasswordCheck.Failed);
        Passwords.Verify(null, Passwords.Hash("qualquer-senha-123")).Should().Be(PasswordCheck.Failed);
    }
}

public class SecretTokensTests
{
    [Fact]
    public void Generate_ReturnsAnOpaqueSecret_AndTheSha256OfIt()
    {
        var (secret, hash) = SecretTokens.Generate();

        secret.Should().NotBeNullOrEmpty();
        secret.Should().MatchRegex("^[A-Za-z0-9_-]+$", "base64url, seguro para cookie");
        hash.Should().HaveCount(32);
        SecretTokens.Hash(secret).Should().Equal(hash);
    }

    [Fact]
    public void Generate_NeverRepeats()
    {
        SecretTokens.Generate().Secret.Should().NotBe(SecretTokens.Generate().Secret);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("curto")]
    [InlineData("isto nao e base64 de jeito nenhum")]
    public void Hash_OfAnythingThatIsNotOurSecret_IsNull(string? text)
    {
        SecretTokens.Hash(text).Should().BeNull();
    }

    [Fact]
    public void Hash_OfAnOverlongText_IsNull()
    {
        SecretTokens.Hash(new string('A', 200)).Should().BeNull();
    }
}
