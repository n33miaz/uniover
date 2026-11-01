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

    /// <summary>
    /// Janela (padrão 10 min, no máximo 1 h) depois da rotação em que o mesmo aparelho, provando a chave da sessão sobre
    /// um desafio de uso único, reapresenta o token acabado de girar (cujo sucessor ninguém usou) e recebe um sucessor
    /// novo em vez de derrubar a sessão. Cobre o iPhone suspendendo a página no meio do refresh. 0 desliga a recuperação.
    /// </summary>
    public int RefreshRecoverySeconds { get; set; } = 600;

    /// <summary>Validade (padrão 2 min) do desafio que o servidor emite para a prova de recuperação.</summary>
    public int RefreshChallengeSeconds { get; set; } = 120;

    public int LockoutThreshold { get; set; } = 5;

    public int LockoutBaseSeconds { get; set; } = 60;

    public int LockoutMaxMinutes { get; set; } = 15;

    public int MinPasswordLength { get; set; } = PasswordPolicy.DefaultMinimumLength;

    public int StreamTicketSeconds { get; set; } = 120;

    /// <summary>Validade do convite de convidado (padrão 7 dias = 168 h, escolha do dono).</summary>
    public int GuestInviteHours { get; set; } = 7 * 24;

    /// <summary>Convites pendentes ao mesmo tempo: segura o dono de acumular links soltos por aí.</summary>
    public int MaxPendingGuestInvites { get; set; } = 10;

    /// <summary>
    /// Por quanto tempo a TV confia na resposta "esta conta de convidado está ativa" (padrão 30 s): é o pior caso para
    /// uma revogação valer em outra instância; na mesma instância ela vale na hora.
    /// </summary>
    public int GuestStatusCacheSeconds { get; set; } = 30;

    /// <summary>Validade do QR de entrada (padrão 2 min): curto porque o QR fica numa tela que qualquer um pode ver.</summary>
    public int QrLoginSeconds { get; set; } = 120;

    /// <summary>
    /// Quanto tempo depois de entrar a conta SEM passkey ainda confirma uma entrada pelo QR sem digitar a senha de novo
    /// (padrão 5 min). Passado isso, o celular pede a senha. Quem tem passkey sempre confirma com ela.
    /// </summary>
    public int QrRecentLoginMinutes { get; set; } = 5;

    /// <summary>Pedidos de entrada pelo QR abertos ao mesmo tempo (padrão 1000): um teto contra quem encheria a tabela.</summary>
    public int QrMaxPending { get; set; } = 1000;

    public IdentityCookieOptions Cookies { get; set; } = new();

    public TimeSpan AccessLifetime => TimeSpan.FromMinutes(AccessMinutes);

    public TimeSpan StreamTicketLifetime => TimeSpan.FromSeconds(StreamTicketSeconds);

    public TimeSpan GuestStatusCacheLifetime => TimeSpan.FromSeconds(GuestStatusCacheSeconds);

    public TimeSpan GuestInviteLifetime => TimeSpan.FromHours(GuestInviteHours);

    public TimeSpan QrLoginLifetime => TimeSpan.FromSeconds(QrLoginSeconds);

    public TimeSpan QrRecentLogin => TimeSpan.FromMinutes(QrRecentLoginMinutes);

    public LockoutPolicy Lockout => new(
        LockoutThreshold, TimeSpan.FromSeconds(LockoutBaseSeconds), TimeSpan.FromMinutes(LockoutMaxMinutes));

    public RefreshPolicy Refresh => new(
        TimeSpan.FromDays(RefreshSlidingDays), TimeSpan.FromDays(RefreshAbsoluteDays), TimeSpan.FromSeconds(ReuseGraceSeconds),
        TimeSpan.FromSeconds(RefreshRecoverySeconds), TimeSpan.FromSeconds(RefreshChallengeSeconds));

    /// <summary>Valores que quebrariam a regra (zero ou negativo); o módulo prefere cair na partida a se comportar mal.</summary>
    internal static bool IsValid(IdentityModuleOptions o) =>
        o.AccessMinutes is >= 1 and <= 60
        && o.RefreshSlidingDays >= 1
        && o.RefreshAbsoluteDays >= o.RefreshSlidingDays
        && o.ReuseGraceSeconds >= 0
        && o.RefreshRecoverySeconds is >= 0 and <= 3600
        && o.RefreshChallengeSeconds is >= 10 and <= 600
        && o.LockoutThreshold >= 1
        && o.LockoutBaseSeconds >= 1
        && o.LockoutMaxMinutes >= 1
        && o.MinPasswordLength >= 1
        && o.StreamTicketSeconds >= 1
        && o.GuestInviteHours is >= 1 and <= 24 * 30
        && o.MaxPendingGuestInvites >= 1
        && o.GuestStatusCacheSeconds is >= 1 and <= 600
        && o.QrLoginSeconds is >= 10 and <= 600
        && o.QrRecentLoginMinutes is >= 0 and <= 60
        && o.QrMaxPending >= 1;
}
