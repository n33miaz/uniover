namespace UniOver.Modules.Identity.Domain;

/// <summary>
/// Ações perigosas do próprio módulo que pedem confirmação com a passkey. Cada módulo declara as suas ao usar a
/// política de confirmação; estes nomes são texto estável, gravado nas confirmações e na auditoria.
/// </summary>
public static class StepUpActions
{
    public const string PasskeyRemove = "identity.passkey-remove";

    /// <summary>Criar um convite de convidado: concede acesso a quem receber o link, então pede a passkey.</summary>
    public const string GuestInvite = "identity.guest-invite";

    /// <summary>Mudar as permissões de um convidado: concede (ou amplia) acesso, então pede a passkey.</summary>
    public const string PermissionsChange = "identity.permissions-change";
    public const string SystemSettingsChange = "identity.system-settings-change";

    /// <summary>Confirmar, no celular, a entrada de um computador pelo QR: dá uma sessão inteira a quem estiver na tela, então pede a passkey.</summary>
    public const string QrLoginApprove = "identity.qr-login-approve";

    /// <summary>Reservada para a confirmação forte da troca quando houver segundo fator cadastrado.</summary>
    public const string PasswordChange = "identity.password-change";
    public const string FactorManage = "identity.factor-manage";
    public const string PasswordRecovery = "identity.password-recovery";
}
