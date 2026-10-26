namespace UniOver.Modules.Tv.Domain;

/// <summary>Reconhece restos de uma TV de outra família sem remover aplicativos ainda instalados.</summary>
internal static class ShortcutFamily
{
    public static bool IsForeignUninstalled(Shortcut shortcut, IReadOnlyCollection<string> capabilities)
    {
        if (shortcut.Installed) return false;
        var samsungPackage = shortcut.Package.StartsWith("samsung.app.", StringComparison.Ordinal);
        var android = capabilities.Contains("tv.kind.android");
        var samsung = capabilities.Contains("tv.kind.samsung");
        // Sem tipo confiável, apagar um app só pela forma do pacote seria arriscado.
        return android != samsung && (android ? samsungPackage : !samsungPackage);
    }
}
