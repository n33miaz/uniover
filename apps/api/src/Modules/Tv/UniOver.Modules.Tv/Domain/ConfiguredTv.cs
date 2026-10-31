using System.Text.Json;
using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Domain;

/// <summary>
/// Uma TV configurada pelo administrador no app (tabela <c>tvs</c>). Por enquanto existe uma só e ela é a padrão: é o
/// computador (agente) dela que recebe os comandos. A tabela já nasce no formato que várias TVs vão precisar; hoje a
/// regra "exatamente uma padrão" vale por um índice único parcial no banco.
/// </summary>
public sealed class ConfiguredTv
{
    public const int NameMax = 60;
    public const int AgentSlugMax = 40;

    /// <summary>Nome da TV quando quem salvou não escolheu um.</summary>
    public const string DefaultName = "TV";

    // Para o EF Core materializar a linha.
    private ConfiguredTv()
    {
    }

    public Guid Id { get; private set; }

    public string Name { get; private set; } = string.Empty;

    /// <summary>
    /// O <c>agentId</c> do computador que controla esta TV. Sem chave estrangeira: o agente é do Devices e a validação
    /// contra os pareados (e não revogados) acontece ao salvar, pela porta de contrato.
    /// </summary>
    public string AgentSlug { get; private set; } = string.Empty;

    public bool IsDefault { get; private set; }

    /// <summary>Permite encerrar apps de fundo nesta TV; desligado até o dono optar explicitamente.</summary>
    public bool AllowBackgroundAppClosing { get; private set; }

    /// <summary>Preferências leves, sempre desligadas enquanto o administrador não as confirma nesta TV.</summary>
    public bool FocusModeEnabled { get; private set; }

    public bool ShortAnimationsEnabled { get; private set; }

    /// <summary>
    /// Com o Modo Foco ligado nesta TV, fecha os outros apps em segundo plano enquanto um stream está em primeiro
    /// plano. Só vale com <see cref="FocusModeEnabled"/>; nunca é enviado ao agente com o foco desligado.
    /// </summary>
    public bool FocusClosesBackground { get; private set; }

    /// <summary>Lista fechada de apps escolhidos para a restrição; nunca inclui pacote do sistema por confiança no cliente.</summary>
    public string RestrictedBackgroundPackages { get; private set; } = "[]";

    /// <summary>
    /// A TV não reconhece mais o UniOver (permissão revogada ou vencida) e o agente parou de tentar, sem pedir de novo em
    /// silêncio. Quem muda é o agente (<c>tv.permission.v1</c>), nunca uma conta; por isso não mexe em
    /// <see cref="UpdatedAt"/> nem em <see cref="UpdatedBy"/>. Só a TV Samsung usa; nas demais fica sempre falso.
    /// </summary>
    public bool PermissionNeeded { get; private set; }

    /// <summary>Quando o agente avisou a última mudança da permissão (nulo: nunca avisou).</summary>
    public DateTimeOffset? PermissionChangedAt { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset UpdatedAt { get; private set; }

    /// <summary>A conta que salvou por último (só o id: a conta é do Identity).</summary>
    public Guid UpdatedBy { get; private set; }

    public static ConfiguredTv CreateDefault(string? name, string agentSlug, Guid updatedBy, DateTimeOffset now)
        => Create(name, agentSlug, isDefault: true, updatedBy, now);

    /// <summary>Cria uma TV adicional. O agente é único no módulo para que estado e mensagens tenham um único destino.</summary>
    public static ConfiguredTv Create(string? name, string agentSlug, bool isDefault, Guid updatedBy, DateTimeOffset now)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(agentSlug);
        var cleanName = NormalizeName(name);

        return new ConfiguredTv
        {
            Id = IdGenerator.NewId(),
            Name = cleanName.Length == 0 ? DefaultName : cleanName,
            AgentSlug = agentSlug,
            IsDefault = isDefault,
            CreatedAt = now,
            UpdatedAt = now,
            UpdatedBy = updatedBy,
        };
    }

    /// <summary>
    /// Passa o controle desta TV para outro computador. Devolve <c>false</c> (e não muda nada, nem a data) quando o
    /// computador e o nome já eram esses. Nome nulo mantém o atual.
    /// </summary>
    public bool Rebind(string agentSlug, string? name, Guid updatedBy, DateTimeOffset now)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(agentSlug);

        var cleanName = NormalizeName(name);
        var newName = cleanName.Length == 0 ? Name : cleanName;
        if (string.Equals(AgentSlug, agentSlug, StringComparison.Ordinal) && string.Equals(Name, newName, StringComparison.Ordinal))
        {
            return false;
        }

        AgentSlug = agentSlug;
        Name = newName;
        UpdatedAt = now;
        UpdatedBy = updatedBy;
        return true;
    }

    /// <summary>
    /// Anota o que o agente disse sobre a permissão da TV. Devolve <c>false</c> (sem mexer em nada, nem na data) quando o
    /// estado já era esse: o agente repete o aviso a cada conexão e isso não pode virar escrita no banco.
    /// </summary>
    public bool SetPermissionNeeded(bool needed, DateTimeOffset at)
    {
        if (PermissionNeeded == needed)
        {
            return false;
        }

        PermissionNeeded = needed;
        PermissionChangedAt = at;
        return true;
    }

    /// <summary>
    /// Liga ou desliga o fechamento de apps em segundo plano desta TV. Devolve <c>false</c> (sem mexer em nada) quando
    /// já estava assim. Nasce desligado: só quem administra as TVs liga, e cada mudança fica na trilha.
    /// </summary>
    public bool SetBackgroundAppClosing(bool allow, Guid updatedBy, DateTimeOffset now)
    {
        if (AllowBackgroundAppClosing == allow)
        {
            return false;
        }

        AllowBackgroundAppClosing = allow;
        UpdatedAt = now;
        UpdatedBy = updatedBy;
        return true;
    }

    public bool SetLightSettings(bool? focusModeEnabled, bool? shortAnimationsEnabled,
        IReadOnlyList<string>? restrictedPackages, Guid updatedBy, DateTimeOffset now, bool? focusClosesBackground = null)
    {
        var packages = restrictedPackages is null ? RestrictedBackgroundPackages : JsonSerializer.Serialize(
            restrictedPackages.Where(CanRestrictInBackground).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal));
        var focus = focusModeEnabled ?? FocusModeEnabled;
        var animations = shortAnimationsEnabled ?? ShortAnimationsEnabled;
        var closes = focusClosesBackground ?? FocusClosesBackground;
        if (focus == FocusModeEnabled && animations == ShortAnimationsEnabled && packages == RestrictedBackgroundPackages
            && closes == FocusClosesBackground)
            return false;
        FocusModeEnabled = focus;
        FocusClosesBackground = closes;
        ShortAnimationsEnabled = animations;
        RestrictedBackgroundPackages = packages;
        UpdatedAt = now;
        UpdatedBy = updatedBy;
        return true;
    }

    public IReadOnlyList<string> BackgroundPackages()
    {
        try { return JsonSerializer.Deserialize<string[]>(RestrictedBackgroundPackages) ?? []; }
        catch (JsonException) { return []; }
    }

    /// <summary>Quantos apps cabem na restrição; o agente recusa mais que isso e a coluna tem tamanho fixo.</summary>
    public const int RestrictedPackagesMax = 100;

    private const int RestrictedPackagesJsonMax = 4000;

    // O que nunca se restringe: sistema, Configurações, serviços do Google, Play Store, o serviço do controle remoto
    // e o lançador. O agente repete a regra e ainda lê da TV a tela inicial, o teclado e a acessibilidade em uso.
    private static readonly HashSet<string> BackgroundBlocked = new(StringComparer.Ordinal)
    {
        "android", "com.android.systemui", "com.android.tv.settings", "com.android.settings",
        "com.google.android.gms", "com.google.android.gsf", "com.google.android.tv.remote.service",
        "com.google.android.tvrecommendations", "com.android.vending", "com.android.tvlauncher",
        "com.google.android.tvlauncher", "com.google.android.apps.tv.launcherx", "com.google.android.leanbacklauncher",
        "com.google.android.inputmethod.latin", "com.google.android.marvin.talkback", "com.android.packageinstaller",
        "com.google.android.packageinstaller", "com.google.android.permissioncontroller",
    };

    private static readonly string[] BackgroundBlockedPrefixes =
        ["com.tcl.", "com.mediatek.", "com.droidlogic.", "com.android.providers.", "com.android.inputmethod."];

    /// <summary>O pacote tem forma plausível e não é peça do sistema, do lançador, do teclado nem do controle remoto.</summary>
    public static bool CanRestrictInBackground(string package) =>
        package.Length is > 2 and <= 255
        && System.Text.RegularExpressions.Regex.IsMatch(package, "^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$")
        && !BackgroundBlocked.Contains(package)
        && !BackgroundBlockedPrefixes.Any(prefix => package.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        && !package.Contains("remote", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// A lista é aceitável? Nula (não veio) é. Recusa item nulo, formato inválido, tamanho acima do que o agente e a
    /// coluna aguentam, repetição e pacote protegido (sistema, lançador, teclado, controle remoto).
    /// </summary>
    public static bool IsValidRestrictedPackages(IReadOnlyList<string?>? packages) =>
        packages is null
        || (packages.Count <= RestrictedPackagesMax
            && packages.All(package => package is not null && CanRestrictInBackground(package))
            && packages.Distinct(StringComparer.Ordinal).Count() == packages.Count
            && JsonSerializer.Serialize(packages).Length <= RestrictedPackagesJsonMax);

    /// <summary>
    /// O nome como é guardado e comparado: normalizado (<see cref="LabelText"/>), para dois nomes que só diferem em espaços
    /// ou em caracteres invisíveis nem chegarem a existir. Vazio quando não há nome. A API já recusou com 400 o nome com
    /// caractere de controle ou invisível; por outro caminho isso falha em vez de gravar.
    /// </summary>
    private static string NormalizeName(string? name)
    {
        var text = LabelText.Normalize(name);
        return text.IsValid
            ? text.Value
            : throw new ArgumentException("O nome tem caracteres de controle ou invisíveis.", nameof(name));
    }
}
