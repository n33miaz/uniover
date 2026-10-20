using System.Text.Json.Serialization;
using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Domain;

/// <summary>
/// Um atalho de app da TV. Nenhum nome de app é fixo no código: o pacote e o rótulo vêm da lista que o agente
/// manda; a posição define o "Atalho n" da tela e o dono pode dar um nome próprio (<see cref="CustomLabel"/>).
/// </summary>
public sealed class Shortcut
{
    public const int PackageMax = 255;
    public const int TvLabelMax = 100;
    public const int CustomLabelMax = 40;
    public const int IconMimeMax = 20;
    public const int IconSha256Length = 64;

    // Para o EF Core materializar a linha.
    private Shortcut()
    {
    }

    public Guid Id { get; private set; }

    public string Package { get; private set; } = string.Empty;

    /// <summary>Nome que a TV informa para o app; fica guardado, mas a tela não o mostra por padrão.</summary>
    public string? TvLabel { get; private set; }

    public string? CustomLabel { get; private set; }

    /// <summary>Posição estável (1, 2, 3...): quem entra depois vai para o fim e ninguém é renumerado.</summary>
    public int Position { get; private set; }

    /// <summary>Escolha do dono: <c>false</c> tira o app da fileira de atalhos do controle (ele segue podendo ser aberto pelo painel Apps).</summary>
    public bool Enabled { get; private set; } = true;

    /// <summary>
    /// <c>false</c> quando o pacote sumiu da última lista da TV. É separado de <see cref="Enabled"/> para que um app
    /// que o dono escondeu não reapareça sozinho na próxima atualização, e um que voltou a ser instalado reapareça.
    /// </summary>
    public bool Installed { get; private set; } = true;

    /// <summary>Tipo da imagem do ícone (<c>image/png</c> ou <c>image/webp</c>); nulo enquanto o agente não mandou nenhum.</summary>
    public string? IconMime { get; private set; }

    /// <summary>Bytes da imagem do ícone (até <see cref="ShortcutIcon.MaxBytes"/>).</summary>
    public byte[]? IconData { get; private set; }

    /// <summary>SHA-256 (hexadecimal) da imagem: permite regravar o ícone só quando ele mudou.</summary>
    public string? IconSha256 { get; private set; }

    public DateTimeOffset UpdatedAt { get; private set; }

    /// <summary>O que a tela mostra como "no controle" (a fileira de atalhos): escolhido pelo dono e ainda instalado.</summary>
    public bool IsActive => Enabled && Installed;

    public static Shortcut Create(string package, string? tvLabel, int position, DateTimeOffset now) =>
        new()
        {
            Id = IdGenerator.NewId(),
            Package = package,
            TvLabel = Clip(tvLabel, TvLabelMax),
            Position = position,
            UpdatedAt = now,
        };

    /// <summary>Atualiza o que veio da TV, sem tocar no rótulo do dono nem na posição.</summary>
    internal bool ApplyFromTv(string? tvLabel, DateTimeOffset now)
    {
        var label = Clip(tvLabel, TvLabelMax);
        if (string.Equals(TvLabel, label, StringComparison.Ordinal) && Installed)
        {
            return false;
        }

        TvLabel = label;
        Installed = true;
        UpdatedAt = now;
        return true;
    }

    /// <summary>
    /// Guarda o ícone que o agente mandou, sem tocar em rótulo próprio, posição nem ocultação. Imagem igual à que já
    /// está guardada não regrava nada (devolve <c>false</c>). Quem nunca manda ícone (<c>tv.apps.v1</c>) nunca passa por
    /// aqui, então um ícone guardado não é apagado por uma lista sem ícones.
    /// </summary>
    internal bool SetIcon(ShortcutIcon icon, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(icon);
        var hash = icon.Sha256();
        if (string.Equals(IconSha256, hash, StringComparison.Ordinal) && string.Equals(IconMime, icon.Mime, StringComparison.Ordinal))
        {
            return false;
        }

        IconMime = icon.Mime;
        IconData = icon.Data;
        IconSha256 = hash;
        UpdatedAt = now;
        return true;
    }

    internal bool MarkGone(DateTimeOffset now)
    {
        if (!Installed)
        {
            return false;
        }

        Installed = false;
        UpdatedAt = now;
        return true;
    }

    /// <summary>Texto vazio ou só espaços apaga o rótulo próprio e a tela volta a "Atalho n".</summary>
    public void SetCustomLabel(string? label, DateTimeOffset now)
    {
        CustomLabel = string.IsNullOrWhiteSpace(label) ? null : Clip(label.Trim(), CustomLabelMax);
        UpdatedAt = now;
    }

    public void SetEnabled(bool enabled, DateTimeOffset now)
    {
        Enabled = enabled;
        UpdatedAt = now;
    }

    private static string? Clip(string? value, int max) =>
        value is null ? null : value.Length <= max ? value : value[..max];
}

/// <summary>Um app que o agente informou (<c>tv.apps.v1</c> ou <c>tv.apps.v2</c>); sem <see cref="Icon"/>, o ícone guardado fica.</summary>
public sealed record IncomingApp(string Package, string? Label, ShortcutIcon? Icon = null);

/// <summary>
/// Atalho como a tela o recebe. <see cref="Enabled"/> é "no controle" (escolhido pelo dono e instalado); <see cref="Installed"/>
/// é só se o app está na TV, e é ele que decide se o app pode ser aberto: um app instalado que o dono não fixou também abre.
/// </summary>
public sealed record TvShortcut(
    Guid Id,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int Position,
    string Package,
    string? TvLabel,
    string? CustomLabel,
    bool Enabled,
    bool Installed,
    string? IconDataUri)
{
    public static TvShortcut From(Shortcut shortcut)
    {
        ArgumentNullException.ThrowIfNull(shortcut);
        return new TvShortcut(shortcut.Id, shortcut.Position, shortcut.Package, shortcut.TvLabel, shortcut.CustomLabel, shortcut.IsActive, shortcut.Installed, shortcut.IconData is { Length: > 0 } && shortcut.IconMime is { } mime
            ? new ShortcutIcon(mime, shortcut.IconData).ToDataUri()
            : null);
    }
}

/// <summary>Regra de como uma lista nova de apps se funde com os atalhos que já existem.</summary>
public static class ShortcutCatalog
{
    /// <summary>
    /// Funde por <c>package</c>: quem já existe mantém rótulo próprio e posição (só o rótulo da TV é atualizado);
    /// quem sumiu da lista fica fora de uso mas não é apagado (se voltar, volta na mesma posição); quem é novo entra
    /// no fim, na ordem em que a TV informou. O ícone só é gravado quando a lista traz um (e muda); app sem ícone na
    /// lista mantém o que já tem. Devolve os atalhos novos (o chamador os persiste) e se algo mudou.
    /// </summary>
    public static (IReadOnlyList<Shortcut> Added, bool Changed) Merge(
        IReadOnlyCollection<Shortcut> existing, IReadOnlyList<IncomingApp> incoming, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(existing);
        ArgumentNullException.ThrowIfNull(incoming);

        var byPackage = existing.ToDictionary(s => s.Package, StringComparer.Ordinal);
        var next = existing.Count == 0 ? 1 : existing.Max(s => s.Position) + 1;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var added = new List<Shortcut>();
        var changed = false;

        foreach (var app in incoming)
        {
            // A mesma lista não deveria repetir pacote; se repetir, vale a primeira ocorrência.
            if (app.Package.Length is 0 or > Shortcut.PackageMax || !seen.Add(app.Package))
            {
                continue;
            }

            if (byPackage.TryGetValue(app.Package, out var current))
            {
                changed |= current.ApplyFromTv(app.Label, now);
                if (app.Icon is { } icon)
                {
                    changed |= current.SetIcon(icon, now);
                }
            }
            else
            {
                var created = Shortcut.Create(app.Package, app.Label, next++, now);
                if (app.Icon is { } icon)
                {
                    created.SetIcon(icon, now);
                }

                added.Add(created);
                changed = true;
            }
        }

        foreach (var shortcut in existing.Where(s => !seen.Contains(s.Package)))
        {
            changed |= shortcut.MarkGone(now);
        }

        return (added, changed);
    }
}
