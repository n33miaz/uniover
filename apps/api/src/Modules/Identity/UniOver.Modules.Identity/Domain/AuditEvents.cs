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
}
