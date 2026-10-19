using UniOver.Modules.Identity.Domain;

namespace UniOver.Modules.Identity;

/// <summary>Opções de cookie do módulo (<c>Modules:Identity:Cookies</c>).</summary>
public sealed class IdentityCookieOptions
{
    /// <summary>
    /// <c>false</c> tira o atributo <c>Secure</c> para desenvolvimento local sem HTTPS. Só é respeitado em
    /// Development e Testing; em qualquer outro ambiente o cookie é sempre <c>Secure</c>.
    /// </summary>
    public bool? SecureOverride { get; set; }
}

/// <summary>
/// Tudo que é ajustável do módulo, em <c>Modules:Identity</c>. Os padrões são os aprovados pelo dono: acesso de
/// 10 min, refresh deslizante de 14 dias com teto de 90, bloqueio depois de 5 falhas, senha de 10 caracteres.
/// </summary>
public sealed class IdentityModuleOptions
{
    public const string SectionName = "Modules:Identity";

    public int AccessMinutes { get; set; } = 10;

    public int RefreshSlidingDays { get; set; } = 14;

    public int RefreshAbsoluteDays { get; set; } = 90;

    public int ReuseGraceSeconds { get; set; } = 3;

    public int LockoutThreshold { get; set; } = 5;

    public int LockoutBaseSeconds { get; set; } = 60;

    public int LockoutMaxMinutes { get; set; } = 15;

    public int MinPasswordLength { get; set; } = PasswordPolicy.DefaultMinimumLength;

    public int StreamTicketSeconds { get; set; } = 120;

    public IdentityCookieOptions Cookies { get; set; } = new();

    public TimeSpan AccessLifetime => TimeSpan.FromMinutes(AccessMinutes);

    public TimeSpan StreamTicketLifetime => TimeSpan.FromSeconds(StreamTicketSeconds);

    public LockoutPolicy Lockout => new(
        LockoutThreshold, TimeSpan.FromSeconds(LockoutBaseSeconds), TimeSpan.FromMinutes(LockoutMaxMinutes));

    public RefreshPolicy Refresh => new(
        TimeSpan.FromDays(RefreshSlidingDays), TimeSpan.FromDays(RefreshAbsoluteDays), TimeSpan.FromSeconds(ReuseGraceSeconds));

    /// <summary>Valores que quebrariam a regra (zero ou negativo); o módulo prefere cair na partida a se comportar mal.</summary>
    internal static bool IsValid(IdentityModuleOptions o) =>
        o.AccessMinutes is >= 1 and <= 60
        && o.RefreshSlidingDays >= 1
        && o.RefreshAbsoluteDays >= o.RefreshSlidingDays
        && o.ReuseGraceSeconds >= 0
        && o.LockoutThreshold >= 1
        && o.LockoutBaseSeconds >= 1
        && o.LockoutMaxMinutes >= 1
        && o.MinPasswordLength >= 1
        && o.StreamTicketSeconds >= 1;
}
