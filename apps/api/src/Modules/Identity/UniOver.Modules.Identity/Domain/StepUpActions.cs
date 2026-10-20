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

    /// <summary>Reservada: o endpoint de trocar a senha ainda não existe, mas o nome já fica separado.</summary>
    public const string PasswordChange = "identity.password-change";
}
