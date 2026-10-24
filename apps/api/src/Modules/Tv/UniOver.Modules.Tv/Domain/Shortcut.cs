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

    /// <summary>TV a que o app pertence; sem FK para deixar a remoção administrativa explícita.</summary>
    public Guid TvId { get; private set; }

    public string Package { get; private set; } = string.Empty;

    /// <summary>Nome que a TV informa para o app; fica guardado, mas a tela não o mostra por padrão.</summary>
    public string? TvLabel { get; private set; }

    public string? CustomLabel { get; private set; }

    /// <summary>
    /// Posição na ordem do dono (1, 2, 3...): quem entra depois vai para o fim, e uma lista nova do agente não mexe em
    /// ninguém. Só quem edita atalhos (o administrador, ou quem recebeu essa permissão) muda a ordem, e ao fazê-lo todos
    /// os atalhos são renumerados de 1 a n (<see cref="ShortcutCatalog.TryReorder"/>).
    /// </summary>
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

    public static Shortcut Create(Guid tvId, string package, string? tvLabel, int position, DateTimeOffset now) =>
        new()
        {
            Id = IdGenerator.NewId(),
            TvId = tvId,
            Package = package,
            TvLabel = Clip(tvLabel, TvLabelMax),
            Position = position,
            UpdatedAt = now,
        };

    /// <summary>Compatibilidade dos testes e chamadas antigas enquanto a TV padrão é materializada na primeira configuração.</summary>
    public static Shortcut Create(string package, string? tvLabel, int position, DateTimeOffset now) =>
        Create(Guid.Empty, package, tvLabel, position, now);

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

    /// <summary>Muda o lugar na ordem do dono; sem mudança (mesma posição) nada é tocado. Devolve se mudou.</summary>
    internal bool SetPosition(int position, DateTimeOffset now)
    {
        if (Position == position)
        {
            return false;
        }

        Position = position;
        UpdatedAt = now;
        return true;
    }

    /// <summary>
    /// Texto vazio ou só espaços apaga o rótulo próprio e a tela volta a "Atalho n". O que se guarda é o texto normalizado
    /// (<see cref="LabelText"/>): quem chama pela API já recusou com 400 o que tem caractere invisível ou de controle; se
    /// algo assim chegar aqui por outro caminho, falha em vez de gravar um rótulo que engana o olho.
    /// </summary>
    /// <exception cref="ArgumentException">O texto tem caractere de controle, invisível ou de direção.</exception>
    public void SetCustomLabel(string? label, DateTimeOffset now)
    {
        var text = LabelText.Normalize(label);
        if (!text.IsValid)
        {
            throw new ArgumentException("O rótulo tem caracteres de controle ou invisíveis.", nameof(label));
        }

        CustomLabel = text.Value.Length == 0 ? null : Clip(text.Value, CustomLabelMax);
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

/// <summary>Regra de como uma lista nova de apps se funde com os atalhos que já existem, e de como o dono muda a ordem deles.</summary>
public static class ShortcutCatalog
{
    /// <summary>
    /// Teto de ids numa lista de reordenação. A lista que o agente manda tem até 500 apps, mas os atalhos nunca são
    /// apagados (um app que saiu da TV só fica fora de uso), então o total guardado pode passar de 500 com o tempo.
    /// </summary>
    public const int MaxReorderIds = 2000;

    /// <summary>
    /// Põe os atalhos na ordem de <paramref name="ids"/> (posições 1 a n). A lista precisa ser uma permutação exata dos
    /// atalhos que existem (todos, cada um uma vez, nenhum desconhecido): é o que garante que a ordem inteira vem do dono
    /// e que ninguém some da fileira por uma lista velha. Se não for, devolve <c>false</c> sem tocar em nada. Os que
    /// não estão no controle ou saíram da TV entram na ordem como qualquer outro: ela só não aparece para eles.
    /// </summary>
    /// <param name="changed"><c>true</c> se alguma posição mudou (nada a gravar quando a ordem já era essa).</param>
    public static bool TryReorder(
        IReadOnlyCollection<Shortcut> existing, IReadOnlyList<Guid> ids, DateTimeOffset now, out bool changed)
    {
        ArgumentNullException.ThrowIfNull(existing);
        ArgumentNullException.ThrowIfNull(ids);

        changed = false;
        if (ids.Count != existing.Count)
        {
            return false;
        }

        var byId = existing.ToDictionary(s => s.Id);
        var seen = new HashSet<Guid>();
        foreach (var id in ids)
        {
            if (!byId.ContainsKey(id) || !seen.Add(id))
            {
                return false;
            }
        }

        var position = 1;
        foreach (var id in ids)
        {
            changed |= byId[id].SetPosition(position++, now);
        }

        return true;
    }

    /// <summary>
    /// Funde por <c>package</c>: quem já existe mantém rótulo próprio e posição (só o rótulo da TV é atualizado);
    /// quem sumiu da lista fica fora de uso mas não é apagado (se voltar, volta na mesma posição); quem é novo entra
    /// no fim, na ordem em que a TV informou. O ícone só é gravado quando a lista traz um (e muda); app sem ícone na
    /// lista mantém o que já tem. Devolve os atalhos novos (o chamador os persiste) e se algo mudou.
    /// </summary>
    public static (IReadOnlyList<Shortcut> Added, bool Changed) Merge(
        IReadOnlyCollection<Shortcut> existing, IReadOnlyList<IncomingApp> incoming, DateTimeOffset now, Guid? tvId = null)
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
                var targetTvId = existing.FirstOrDefault()?.TvId ?? tvId ?? Guid.Empty;
                var created = Shortcut.Create(targetTvId, app.Package, app.Label, next++, now);
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
