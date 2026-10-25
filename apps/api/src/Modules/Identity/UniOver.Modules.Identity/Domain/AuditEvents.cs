namespace UniOver.Modules.Identity.Domain;

/// <summary>Valores da coluna <c>event</c> de <c>login_audit</c>: texto estável, lido por quem consulta o banco.</summary>
public static class AuditEvents
{
    public const string LoginSucceeded = "login_succeeded";
    public const string LoginFailed = "login_failed";
    public const string LoginLocked = "login_locked";
    public const string RefreshSucceeded = "refresh_succeeded";
    public const string RefreshReuseDetected = "refresh_reuse_detected";
    public const string Logout = "logout";
    public const string OwnerCreated = "owner_created";
    public const string PasskeyRegistered = "passkey_registered";
    public const string PasskeyRemoved = "passkey_removed";
    public const string StepUpSucceeded = "step_up_succeeded";
    public const string StepUpFailed = "step_up_failed";
    public const string GuestInviteCreated = "guest_invite_created";
    public const string GuestInviteAccepted = "guest_invite_accepted";
    public const string GuestInviteRevoked = "guest_invite_revoked";
    public const string GuestRevoked = "guest_revoked";

    /// <summary>O dono mudou as permissões de um convidado. O detalhe leva o id da conta e o que entrou e saiu (nunca nome nem e-mail).</summary>
    public const string PermissionsChanged = "permissions_changed";

    /// <summary>A pessoa mudou o próprio perfil (o nome). O detalhe diz só QUAL campo mudou, nunca o valor.</summary>
    public const string ProfileUpdated = "profile_updated";

    /// <summary>A pessoa renomeou uma passkey. O detalhe leva só o id da passkey, nunca o nome.</summary>
    public const string PasskeyRenamed = "passkey_renamed";

    /// <summary>O administrador exportou a trilha (IP e aparelho de terceiros saem do sistema). O detalhe leva só a quantidade de linhas.</summary>
    public const string AuditExported = "audit_exported";

    /// <summary>
    /// Uma conta confirmou, no celular, a entrada de um computador pelo QR (IP e aparelho do CELULAR). O detalhe é o id do
    /// pedido, o mesmo do <see cref="QrLoginSucceeded"/> que vem depois (IP e aparelho do COMPUTADOR).
    /// </summary>
    public const string QrLoginApproved = "qr_login_approved";

    /// <summary>A conta recusou, no celular, a entrada de um computador pelo QR. O detalhe é o id do pedido.</summary>
    public const string QrLoginDenied = "qr_login_denied";

    /// <summary>O computador recebeu a sessão da conta (IP e aparelho do COMPUTADOR). O detalhe é o id do pedido.</summary>
    public const string QrLoginSucceeded = "qr_login_succeeded";

    /// <summary>Todos os eventos que esta trilha grava, na ordem em que a tela os lista.</summary>
    public static IReadOnlyList<string> All { get; } =
    [
        LoginSucceeded,
        LoginFailed,
        LoginLocked,
        RefreshSucceeded,
        RefreshReuseDetected,
        Logout,
        OwnerCreated,
        PasskeyRegistered,
        PasskeyRenamed,
        PasskeyRemoved,
        StepUpSucceeded,
        StepUpFailed,
        GuestInviteCreated,
        GuestInviteAccepted,
        GuestInviteRevoked,
        GuestRevoked,
        PermissionsChanged,
        ProfileUpdated,
        QrLoginApproved,
        QrLoginDenied,
        QrLoginSucceeded,
        AuditExported,
    ];
}

/// <summary>
/// O <c>detail</c> dos eventos em que alguém SEM LOGIN agiu sobre uma conta (senha errada, conta bloqueada, refresh
/// reutilizado). Nesses eventos o ator é nulo (quem tentou é desconhecido: o IP e o aparelho continuam gravados) e a
/// conta que sofreu a tentativa vai no começo do detalhe, no mesmo formato dos eventos do administrador sobre uma conta
/// (<c>N</c>, 32 hexadecimais), seguida do motivo quando há: <c>id</c> ou <c>id|motivo</c>. Nunca o e-mail digitado.
/// </summary>
public static class AuditAboutAccount
{
    public static string Detail(Guid accountId, string? reason = null) =>
        string.IsNullOrEmpty(reason) ? accountId.ToString("N") : $"{accountId:N}|{reason}";
}
