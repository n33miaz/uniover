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
    /// pela migration) OU tem agora a concessão de <paramref name="modulePermission"/> (ex.: <c>module:tv</c>). É a leitura direta da
    /// verdade do Identity: não depende de nenhum aviso já ter sido entregue. Conta inexistente responde <c>false</c>.
    /// </summary>
    Task<bool> PredatesInvitesOrHoldsModuleAsync(Guid userId, string modulePermission, CancellationToken cancellationToken = default);
}
