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
        parsed!.Key.Should().Be(TvKeyV2BodyKey.VolumeUp);
        parsed.Direction.Should().BeNull();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("volume_up")]
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
