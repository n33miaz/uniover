namespace UniOver.Modules.Identity.Contracts;

/// <summary>
/// O papel e a origem das contas, para quem não conhece a persistência do Identity. O administrador (papel <c>owner</c>)
/// enxerga todas as TVs, qualquer que seja a filiação dele.
/// </summary>
public interface IAccountRoleDirectory
{
    /// <summary>Entre <paramref name="userIds"/>, as contas que são administradoras. Conta inexistente não entra.</summary>
    Task<IReadOnlyCollection<Guid>> OwnersAmongAsync(IReadOnlyCollection<Guid> userIds, CancellationToken cancellationToken = default);

    /// <summary>
    /// Se a conta já existia antes de o acesso a módulos passar a ser concedido conta a conta (marca gravada uma única vez,
    /// pela migration). Conta inexistente responde <c>false</c>: na dúvida, nada de compartilhado é mostrado.
    /// </summary>
    Task<bool> PredatesModuleInvitesAsync(Guid userId, CancellationToken cancellationToken = default);
}
