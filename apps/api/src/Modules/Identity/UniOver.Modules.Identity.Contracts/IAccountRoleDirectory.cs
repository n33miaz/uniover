namespace UniOver.Modules.Identity.Contracts;

/// <summary>
/// O papel das contas, para quem não conhece a persistência do Identity. O administrador (papel <c>owner</c>) enxerga todas as TVs,
/// qualquer que seja a filiação dele.
/// </summary>
public interface IAccountRoleDirectory
{
    /// <summary>Entre <paramref name="userIds"/>, as contas que são administradoras. Conta inexistente não entra.</summary>
    Task<IReadOnlyCollection<Guid>> OwnersAmongAsync(IReadOnlyCollection<Guid> userIds, CancellationToken cancellationToken = default);
}
