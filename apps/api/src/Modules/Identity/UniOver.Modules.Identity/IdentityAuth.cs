namespace UniOver.Modules.Identity;

/// <summary>Nomes das políticas de autorização que o módulo declara.</summary>
public static class IdentityAuth
{
    /// <summary>Qualquer conta autenticada (dono ou convidado): só para o que é da própria sessão (sair, quem sou, bilhete de stream).</summary>
    public const string AccountSessionPolicy = "IdentityAccountSession";

    /// <summary>
    /// Como <see cref="AccountSessionPolicy"/>, mas para ESCREVER no próprio perfil: o convidado revogado, ainda com o JWT
    /// de acesso válido por alguns minutos, não escreve mais nada.
    /// </summary>
    public const string ActiveAccountSessionPolicy = "IdentityActiveAccountSession";
}
