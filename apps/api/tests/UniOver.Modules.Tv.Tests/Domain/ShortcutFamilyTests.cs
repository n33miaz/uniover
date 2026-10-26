using AwesomeAssertions;
using UniOver.Modules.Tv.Domain;

namespace UniOver.Modules.Tv.Tests.Domain;

public sealed class ShortcutFamilyTests
{
    [Fact]
    public void KeepsInstalledAppsAndRemovesOnlyForeignUninstalledPackages()
    {
        var now = DateTimeOffset.UtcNow;
        var samsung = Shortcut.Create("samsung.app.netflix", "Netflix", 1, now);
        var android = Shortcut.Create("com.netflix.mediaclient", "Netflix", 2, now);
        samsung.MarkGone(now);
        android.MarkGone(now);

        ShortcutFamily.IsForeignUninstalled(samsung, ["tv.kind.android"]).Should().BeTrue();
        ShortcutFamily.IsForeignUninstalled(android, ["tv.kind.samsung"]).Should().BeTrue();
        ShortcutFamily.IsForeignUninstalled(samsung, ["tv.kind.samsung"]).Should().BeFalse();
        ShortcutFamily.IsForeignUninstalled(android, ["tv.kind.android"]).Should().BeFalse();
        ShortcutFamily.IsForeignUninstalled(samsung, []).Should().BeFalse();
        ShortcutFamily.IsForeignUninstalled(Shortcut.Create("samsung.app.active", "Ativo", 3, now), ["tv.kind.android"]).Should().BeFalse();
    }
}
