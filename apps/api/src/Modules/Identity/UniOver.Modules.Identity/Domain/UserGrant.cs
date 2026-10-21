using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Identity.Domain;

/// <summary>
/// Uma permissão concedida a uma conta de convidado (<see cref="AccessPermissions"/>). O dono
/// não tem linhas aqui: ele tem tudo de forma implícita. O conjunto de linhas de uma conta É o que ela pode fazer; quem e
/// quando concedeu ficam gravados para a auditoria (sem chave estrangeira: a trilha sobrevive à exclusão manual do dono).
/// </summary>
public sealed class UserGrant
{
    // Para o EF Core materializar a linha.
    private UserGrant()
    {
    }

    public Guid UserId { get; private set; }

    public string Permission { get; private set; } = string.Empty;

    /// <summary>Id do dono que concedeu (ou que criou o convite, quando a concessão veio do aceite).</summary>
    public Guid GrantedBy { get; private set; }

    public DateTimeOffset GrantedAt { get; private set; }

    public static UserGrant Create(Guid userId, string permission, Guid grantedBy, DateTimeOffset now)
    {
        if (!AccessPermissions.IsKnown(permission))
        {
            throw new ArgumentException("Permissão fora do catálogo.", nameof(permission));
        }

        return new UserGrant { UserId = userId, Permission = permission, GrantedBy = grantedBy, GrantedAt = now };
    }
}
