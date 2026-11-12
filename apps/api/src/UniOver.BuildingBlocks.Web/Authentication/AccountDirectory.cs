namespace UniOver.BuildingBlocks.Web;

/// <summary>Uma conta como os outros módulos a mostram: o id e o nome de exibição, nada mais.</summary>
public sealed record AccountName(Guid UserId, string DisplayName);

/// <summary>
/// Porta: o nome das contas, para um módulo mostrar pessoas sem conhecer o interior do Identity (quem guarda as contas
/// a implementa; um módulo extraído troca por um cliente HTTP). Só o nome de exibição sai daqui: nunca e-mail, papel
/// ou qualquer outro dado da conta.
/// </summary>
public interface IAccountDirectory
{
    /// <summary>As contas ativas que têm <paramref name="permission"/> agora (o administrador tem todas), por nome.</summary>
    Task<IReadOnlyList<AccountName>> WithPermissionAsync(string permission, CancellationToken cancellationToken = default);

    /// <summary>O nome de cada conta de <paramref name="userIds"/> que existe (ativa ou não). Conta inexistente não entra.</summary>
    Task<IReadOnlyList<AccountName>> NamesAsync(IReadOnlyCollection<Guid> userIds, CancellationToken cancellationToken = default);
}
