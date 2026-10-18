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
}
