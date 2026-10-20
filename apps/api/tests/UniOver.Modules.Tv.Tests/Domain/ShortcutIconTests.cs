using AwesomeAssertions;
using UniOver.Modules.Tv.Domain;

namespace UniOver.Modules.Tv.Tests.Domain;

public class ShortcutIconTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 20, 12, 0, 0, TimeSpan.Zero);

    private static readonly byte[] PngHead = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    /// <summary>Bytes que começam como um PNG (a defesa confere a assinatura, não decodifica a imagem).</summary>
    internal static byte[] Png(int length = 64, byte fill = 7)
    {
        var data = new byte[length];
        Array.Fill(data, fill);
        PngHead.CopyTo(data, 0);
        return data;
    }

    internal static byte[] Webp(int length = 64)
    {
        var data = new byte[length];
        "RIFF"u8.CopyTo(data);
        "WEBP"u8.CopyTo(data.AsSpan(8));
        return data;
    }

    private static string B64(byte[] data) => Convert.ToBase64String(data);

    private static ShortcutIcon Icon(byte[]? png = null) => new(ShortcutIcon.Png, png ?? Png());

    // ---- decodificação e conferência na borda ----

    [Fact]
    public void PngAndWebp_AreAccepted_AndKeepTheirBytes()
    {
        ShortcutIcon.TryCreate("image/png", B64(Png()), out var png).Should().BeTrue();
        png!.Mime.Should().Be("image/png");
        png.Data.Should().Equal(Png());

        ShortcutIcon.TryCreate("image/webp", B64(Webp()), out var webp).Should().BeTrue();
        webp!.Mime.Should().Be("image/webp");
    }

    [Fact]
    public void TheLimitIs32KiB_AndOneByteMoreIsRefused()
    {
        ShortcutIcon.TryCreate("image/png", B64(Png(ShortcutIcon.MaxBytes)), out var exact).Should().BeTrue();
        exact!.Data.Should().HaveCount(32768);
        ShortcutIcon.MaxBase64Chars.Should().Be(43692);

        ShortcutIcon.TryCreate("image/png", B64(Png(ShortcutIcon.MaxBytes + 1)), out var over).Should().BeFalse();
        over.Should().BeNull();
    }

    [Fact]
    public void AnAbsurdlyLongString_IsRefusedBeforeAnyAllocation()
    {
        ShortcutIcon.TryCreate("image/png", new string('A', ShortcutIcon.MaxBase64Chars + 4), out _).Should().BeFalse();
    }

    [Theory]
    [InlineData("image/gif")]
    [InlineData("image/svg+xml")]
    [InlineData("text/html")]
    [InlineData("IMAGE/PNG")]
    [InlineData("")]
    [InlineData(null)]
    public void AMimeOutsidePngAndWebp_IsRefused(string? mime)
    {
        ShortcutIcon.TryCreate(mime, B64(Png()), out var icon).Should().BeFalse();
        icon.Should().BeNull();
    }

    [Theory]
    [InlineData("not base64 !!")]
    [InlineData("iVBORw0KGgo")]
    [InlineData("iVBO*w0KGgo=")]
    [InlineData("")]
    [InlineData(null)]
    public void InvalidBase64_IsRefused(string? data)
    {
        ShortcutIcon.TryCreate("image/png", data, out var icon).Should().BeFalse();
        icon.Should().BeNull();
    }

    [Fact]
    public void ContentThatDoesNotMatchTheDeclaredType_IsRefused()
    {
        // O tipo vai direto para o `data:` URI que o navegador abre: precisa bater com o conteúdo.
        ShortcutIcon.TryCreate("image/png", B64(Webp()), out _).Should().BeFalse();
        ShortcutIcon.TryCreate("image/webp", B64(Png()), out _).Should().BeFalse();
        ShortcutIcon.TryCreate("image/png", B64("<svg onload=alert(1)/>"u8.ToArray()), out _).Should().BeFalse();
        ShortcutIcon.TryCreate("image/webp", B64("RIFF"u8.ToArray()), out _).Should().BeFalse();
    }

    [Fact]
    public void TheDataUri_HasTheMimeAndTheBase64()
    {
        var icon = Icon();
        icon.ToDataUri().Should().Be("data:image/png;base64," + B64(Png()));
    }

    [Fact]
    public void TheFingerprint_ChangesWithTheContentOnly()
    {
        Icon(Png(fill: 1)).Sha256().Should().HaveLength(Shortcut.IconSha256Length);
        Icon(Png(fill: 1)).Sha256().Should().Be(Icon(Png(fill: 1)).Sha256());
        Icon(Png(fill: 1)).Sha256().Should().NotBe(Icon(Png(fill: 2)).Sha256());
    }

    // ---- fusão com a lista de apps ----

    [Fact]
    public void ANewAppWithAnIcon_IsCreatedWithIt()
    {
        var (added, changed) = ShortcutCatalog.Merge([], [new IncomingApp("a.um", "Um", Icon())], Now);

        changed.Should().BeTrue();
        added.Single().IconMime.Should().Be("image/png");
        added.Single().IconData.Should().Equal(Png());
        added.Single().IconSha256.Should().Be(Icon().Sha256());
        TvShortcut.From(added.Single()).IconDataUri.Should().Be(Icon().ToDataUri());
    }

    [Fact]
    public void AnAppWithoutAnIcon_HasNullInTheListTheScreenReceives()
    {
        var (added, _) = ShortcutCatalog.Merge([], [new IncomingApp("a.um", "Um")], Now);

        added.Single().IconData.Should().BeNull();
        TvShortcut.From(added.Single()).IconDataUri.Should().BeNull();
    }

    [Fact]
    public void AListWithoutIcons_NeverErasesAStoredIcon_AndReportsNoChange()
    {
        var (first, _) = ShortcutCatalog.Merge([], [new IncomingApp("a.um", "Um", Icon())], Now);

        var (added, changed) = ShortcutCatalog.Merge(first, [new IncomingApp("a.um", "Um")], Now.AddMinutes(1));

        added.Should().BeEmpty();
        changed.Should().BeFalse();
        first.Single().IconData.Should().Equal(Png());
    }

    [Fact]
    public void TheSameIconAgain_DoesNotRewriteAnything()
    {
        var (first, _) = ShortcutCatalog.Merge([], [new IncomingApp("a.um", "Um", Icon())], Now);

        var (_, changed) = ShortcutCatalog.Merge(first, [new IncomingApp("a.um", "Um", Icon())], Now.AddMinutes(1));

        changed.Should().BeFalse();
        first.Single().UpdatedAt.Should().Be(Now);
    }

    [Fact]
    public void ADifferentIcon_ReplacesTheStoredOne()
    {
        var (first, _) = ShortcutCatalog.Merge([], [new IncomingApp("a.um", "Um", Icon(Png(fill: 1)))], Now);

        var (_, changed) = ShortcutCatalog.Merge(first, [new IncomingApp("a.um", "Um", Icon(Png(fill: 2)))], Now.AddMinutes(1));

        changed.Should().BeTrue();
        first.Single().IconData.Should().Equal(Png(fill: 2));
        first.Single().IconSha256.Should().Be(Icon(Png(fill: 2)).Sha256());
    }

    [Fact]
    public void TheSameBytesWithAnotherMime_CountAsAChange()
    {
        var (first, _) = ShortcutCatalog.Merge([], [new IncomingApp("a.um", "Um", new ShortcutIcon("image/png", Webp()))], Now);

        var (_, changed) = ShortcutCatalog.Merge(first, [new IncomingApp("a.um", "Um", new ShortcutIcon("image/webp", Webp()))], Now);

        changed.Should().BeTrue();
        first.Single().IconMime.Should().Be("image/webp");
    }

    [Fact]
    public void AnIconUpdate_KeepsTheOwnersLabelPositionAndHiding()
    {
        var (first, _) = ShortcutCatalog.Merge(
            [], [new IncomingApp("a.um", "Um"), new IncomingApp("b.dois", "Dois")], Now);
        var second = first.Single(s => s.Package == "b.dois");
        second.SetCustomLabel("Meu streaming", Now);
        second.SetEnabled(false, Now);

        var (added, _) = ShortcutCatalog.Merge(
            first, [new IncomingApp("b.dois", "Dois", Icon()), new IncomingApp("a.um", "Um", Icon(Png(fill: 3)))], Now.AddMinutes(1));

        added.Should().BeEmpty();
        second.CustomLabel.Should().Be("Meu streaming");
        second.Enabled.Should().BeFalse();
        second.Position.Should().Be(2);
        second.IconData.Should().Equal(Png());
        first.Single(s => s.Package == "a.um").Position.Should().Be(1);
    }

    [Fact]
    public void AnAppThatLeftTheList_KeepsItsIconForWhenItComesBack()
    {
        var (first, _) = ShortcutCatalog.Merge([], [new IncomingApp("a.um", "Um", Icon())], Now);

        ShortcutCatalog.Merge(first, [new IncomingApp("b.dois", "Dois")], Now.AddMinutes(1));

        first.Single().Installed.Should().BeFalse();
        first.Single().IconData.Should().Equal(Png());
    }

    [Fact]
    public void TheIconColumnsHaveTheContractBounds()
    {
        Shortcut.IconMimeMax.Should().BeGreaterThanOrEqualTo("image/webp".Length);
        Shortcut.IconSha256Length.Should().Be(64);
    }
}
