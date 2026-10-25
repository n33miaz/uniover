using AwesomeAssertions;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.ReorderShortcuts;
using UniOver.Modules.Tv.Features.SendKey;
using UniOver.Modules.Tv.Features.SendText;
using UniOver.Modules.Tv.Features.UpdateShortcut;

namespace UniOver.Modules.Tv.Tests.Validation;

public class ValidatorTests
{
    [Fact]
    public void Key_AcceptsAContractKey_WithTheDefaultDirection()
    {
        var errors = SendKeyValidator.Validate(new SendKeyRequest("VOLUME_UP", null), out var parsed);

        errors.Should().BeEmpty();
        parsed!.Key.Should().Be(TvKeyV3BodyKey.VolumeUp);
        parsed.Direction.Should().BeNull();
    }

    [Theory]
    [InlineData("GUIDE", TvKeyV3BodyKey.Guide)]
    [InlineData("BLUE", TvKeyV3BodyKey.Blue)]
    [InlineData("INPUT", TvKeyV3BodyKey.Input)]
    public void Key_AcceptsTheExtraKeysOfTheV3Contract(string name, TvKeyV3BodyKey expected)
    {
        SendKeyValidator.Validate(new SendKeyRequest(name, null), out var parsed).Should().BeEmpty();
        parsed!.Key.Should().Be(expected);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("volume_up")]
    [InlineData("FACTORY_RESET")]
    [InlineData("HOME; DROP")]
    [InlineData("KEYCODE_HOME")]
    public void Key_RejectsAnythingOutsideTheContract(string? key)
    {
        var errors = SendKeyValidator.Validate(new SendKeyRequest(key, null), out var parsed);

        errors.Should().ContainKey("key");
        parsed.Should().BeNull();
    }

    [Fact]
    public void Key_RejectsPower_BecauseTurningOffHasItsOwnRoute()
    {
        var errors = SendKeyValidator.Validate(new SendKeyRequest("POWER", null), out _);

        errors.Should().ContainKey("key");
    }

    [Fact]
    public void Key_RejectsAnUnknownDirection_AndAcceptsTheKnownOnes()
    {
        SendKeyValidator.Validate(new SendKeyRequest("UP", "SIDEWAYS"), out _).Should().ContainKey("direction");
        SendKeyValidator.Validate(new SendKeyRequest("UP", "END_LONG"), out var parsed).Should().BeEmpty();
        parsed!.Direction.Should().Be(TvKeyV2BodyDirection.EndLong);
    }

    [Fact]
    public void Key_RejectsAMissingBody()
    {
        SendKeyValidator.Validate(null, out var parsed).Should().ContainKey("key");
        parsed.Should().BeNull();
    }

    [Theory]
    [InlineData("")]
    [InlineData("a")]
    [InlineData("olá, mundo")]
    [InlineData("🙂 emoji conta como um caractere")]
    public void Text_AcceptsPrintableAndEmptyText(string text)
    {
        SendTextValidator.Validate(new SendTextRequest(text)).Should().BeEmpty();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("linha\nnova")]
    [InlineData("tab\taqui")]
    [InlineData("nulo\u0000no meio")]
    [InlineData("controle\u0085c1")]
    [InlineData("del\u007f")]
    public void Text_RejectsMissingAndControlCharacters(string? text)
    {
        SendTextValidator.Validate(new SendTextRequest(text)).Should().ContainKey("text");
    }

    [Fact]
    public void Text_LimitIs200CharactersCountedAsUnicodeCharacters()
    {
        SendTextValidator.Validate(new SendTextRequest(new string('x', 200))).Should().BeEmpty();
        SendTextValidator.Validate(new SendTextRequest(new string('x', 201))).Should().ContainKey("text");

        // 200 emojis são 400 unidades UTF-16, mas 200 caracteres para o contrato.
        SendTextValidator.Validate(new SendTextRequest(string.Concat(Enumerable.Repeat("🙂", 200)))).Should().BeEmpty();
        SendTextValidator.Validate(new SendTextRequest(string.Concat(Enumerable.Repeat("🙂", 201)))).Should().ContainKey("text");
    }

    [Fact]
    public void UpdateShortcut_NeedsAtLeastOneField()
    {
        UpdateShortcutValidator.Validate(null).Should().ContainKey("body");
        UpdateShortcutValidator.Validate(new UpdateShortcutRequest(null, null)).Should().ContainKey("body");
        UpdateShortcutValidator.Validate(new UpdateShortcutRequest(null, false)).Should().BeEmpty();
        UpdateShortcutValidator.Validate(new UpdateShortcutRequest("", null)).Should().BeEmpty();
    }

    [Fact]
    public void UpdateShortcut_LimitsTheCustomLabel()
    {
        UpdateShortcutValidator.Validate(new UpdateShortcutRequest(new string('n', 40), null)).Should().BeEmpty();
        UpdateShortcutValidator.Validate(new UpdateShortcutRequest(new string('n', 41), null)).Should().ContainKey("customLabel");
        UpdateShortcutValidator.Validate(new UpdateShortcutRequest("com\nquebra", null)).Should().ContainKey("customLabel");
    }

    [Theory]
    [InlineData("\U0000202Eevil")]              // sobreposição da direita para a esquerda
    [InlineData("a\U0000200Eb")]                // marca de direção
    [InlineData("a\U0000200Bb")]                // espaço de largura zero
    [InlineData("a\U0000200Cb")]                // junção sem largura
    [InlineData("a\U0000200Db")]                // junção de largura zero entre letras
    [InlineData("a\U00002028b")]                // separador de linha
    [InlineData("a\U00002029b")]                // separador de parágrafo
    [InlineData("\U0000FEFFTV")]                // marca de ordem de byte
    [InlineData("\U000E0067tag")]               // marca de tag
    public void UpdateShortcut_RefusesInvisibleAndDirectionCharacters(string label)
    {
        var errors = UpdateShortcutValidator.Validate(new UpdateShortcutRequest(label, null), out var normalized);

        errors.Should().ContainKey("customLabel");
        normalized.Should().BeNull("o que foi recusado não segue para o comando");
    }

    [Fact]
    public void UpdateShortcut_PassesTheNormalizedLabelOn_NotTheRawOne()
    {
        UpdateShortcutValidator.Validate(new UpdateShortcutRequest("  Meu\U000000A0  app ", null), out var spaced).Should().BeEmpty();
        UpdateShortcutValidator.Validate(new UpdateShortcutRequest("Cafe\U00000301", null), out var composed).Should().BeEmpty();
        UpdateShortcutValidator.Validate(new UpdateShortcutRequest("   ", null), out var cleared).Should().BeEmpty();
        UpdateShortcutValidator.Validate(new UpdateShortcutRequest(null, true), out var untouched).Should().BeEmpty();
        UpdateShortcutValidator.Validate(new UpdateShortcutRequest("\U0001F469\U0000200D\U0001F4BB", null), out var emoji).Should().BeEmpty();

        spaced.Should().Be("Meu app");
        composed.Should().Be("Caf\U000000E9");
        cleared.Should().BeEmpty("texto só de espaços apaga o rótulo próprio");
        untouched.Should().BeNull("sem rótulo na requisição, o rótulo não muda");
        emoji.Should().Be("\U0001F469\U0000200D\U0001F4BB", "a junção dentro do emoji composto fica");
    }

    [Fact]
    public void UpdateShortcut_CountsTheLengthOfTheNormalizedLabel()
    {
        // 40 letras com espaços sobrando nas pontas e no meio: depois de normalizar cabem no limite.
        var padded = "  " + new string('n', 19) + "   " + new string('n', 20) + "  ";

        UpdateShortcutValidator.Validate(new UpdateShortcutRequest(padded, null), out var normalized).Should().BeEmpty();
        normalized!.Length.Should().Be(40);
        UpdateShortcutValidator.Validate(new UpdateShortcutRequest(new string('n', 5000), null), out _).Should().ContainKey("customLabel");
    }

    [Fact]
    public void ReorderShortcuts_NeedsTheListOfIds()
    {
        ReorderShortcutsValidator.Validate(null).Should().ContainKey("ids");
        ReorderShortcutsValidator.Validate(new ReorderShortcutsRequest(null)).Should().ContainKey("ids");
        ReorderShortcutsValidator.Validate(new ReorderShortcutsRequest([Guid.NewGuid(), Guid.NewGuid()])).Should().BeEmpty();
    }

    [Fact]
    public void ReorderShortcuts_RefusesARepeatedId()
    {
        var id = Guid.NewGuid();

        ReorderShortcutsValidator.Validate(new ReorderShortcutsRequest([id, Guid.NewGuid(), id])).Should().ContainKey("ids");
    }

    [Fact]
    public void ReorderShortcuts_LimitsTheSizeOfTheList()
    {
        static Guid[] Of(int count) => [.. Enumerable.Range(0, count).Select(_ => Guid.NewGuid())];

        ReorderShortcutsValidator.Validate(new ReorderShortcutsRequest(Of(ShortcutCatalog.MaxReorderIds))).Should().BeEmpty();
        ReorderShortcutsValidator.Validate(new ReorderShortcutsRequest(Of(ShortcutCatalog.MaxReorderIds + 1))).Should().ContainKey("ids");
    }
}
