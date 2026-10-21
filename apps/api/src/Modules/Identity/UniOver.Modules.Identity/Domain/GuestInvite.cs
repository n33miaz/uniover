using UniOver.BuildingBlocks.Web;
using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Domain;

/// <summary>Em que pé está um convite, num instante dado.</summary>
public enum InviteStatus
{
    /// <summary>Pode ser aceito.</summary>
    Pending,

    /// <summary>Já virou conta.</summary>
    Used,

    /// <summary>O dono cancelou antes de ser aceito.</summary>
    Revoked,

    /// <summary>Passou do prazo sem ser aceito.</summary>
    Expired,
}

/// <summary>
/// Convite do dono para uma pessoa criar a própria conta de convidado. O segredo do link nunca é gravado: só o
/// SHA-256 dele. Uso único (<see cref="UsedAt"/>), com prazo e revogável. Quem recebe o link define a própria senha,
/// então o dono nunca a conhece.
/// </summary>
public sealed class GuestInvite
{
    /// <summary>
    /// O nome do convite vira o nome inicial da conta, então segue a mesma regra do nome de exibição
    /// (<see cref="DisplayNameRules"/>): um nome com caractere invisível não entra por aqui.
    /// </summary>
    public const int LabelMaxLength = DisplayNameRules.MaxLength;

    // Para o EF Core materializar a linha.
    private GuestInvite()
    {
    }

    public Guid Id { get; private set; }

    public byte[] TokenHash { get; private set; } = [];

    /// <summary>Papel que a conta recebe ao aceitar (hoje só convidado).</summary>
    public string Role { get; private set; } = AccountRoles.Guest;

    /// <summary>Nome que o dono deu ao convidado; vira o nome da conta.</summary>
    public string Label { get; private set; } = string.Empty;

    /// <summary>Id do dono que criou (sem FK: a trilha sobrevive à exclusão manual da conta dele).</summary>
    public Guid CreatedBy { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset ExpiresAt { get; private set; }

    public DateTimeOffset? UsedAt { get; private set; }

    /// <summary>Id da conta criada pelo aceite (sem FK, de propósito).</summary>
    public Guid? UsedBy { get; private set; }

    public DateTimeOffset? RevokedAt { get; private set; }

    /// <summary>
    /// O que a conta recebe ao aceitar: copiado para <see cref="UserGrant"/> na mesma transação que cria a conta. Já
    /// conferido por <see cref="PermissionRules.Validate"/> (sem repetidas, na ordem do catálogo). Convites criados antes
    /// das permissões existirem ficam com o modelo "só controle da TV" (o padrão da coluna no banco).
    /// </summary>
    public string[] Permissions { get; private set; } = [];

    /// <param name="permissions">Nulo = o modelo "só controle da TV" (<see cref="PermissionRules.TvControlOnly"/>).</param>
    /// <exception cref="ArgumentException">Nome ou lista de permissões fora das regras.</exception>
    public static GuestInvite Create(
        Guid createdBy,
        string label,
        byte[] tokenHash,
        DateTimeOffset now,
        TimeSpan validFor,
        IReadOnlyCollection<string>? permissions = null)
    {
        ArgumentNullException.ThrowIfNull(tokenHash);
        if (validFor <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(validFor), "O convite precisa valer um tempo positivo.");
        }

        var name = NormalizeLabel(label) ?? throw new ArgumentException("Informe o nome do convidado.", nameof(label));
        var checkedPermissions = PermissionRules.Validate(permissions ?? PermissionRules.TvControlOnly);
        if (!checkedPermissions.IsValid)
        {
            throw new ArgumentException("Permissões fora das regras.", nameof(permissions));
        }

        return new GuestInvite
        {
            Id = IdGenerator.NewId(),
            TokenHash = tokenHash,
            Role = AccountRoles.Guest,
            Label = name,
            CreatedBy = createdBy,
            CreatedAt = now,
            ExpiresAt = now + validFor,
            Permissions = [.. checkedPermissions.Permissions],
        };
    }

    /// <summary>O nome já normalizado pelas regras do nome de exibição; nulo se vazio, grande demais ou com caractere proibido.</summary>
    public static string? NormalizeLabel(string? label) => DisplayNameRules.Normalize(label).Value;

    /// <summary>
    /// A ordem importa: usado e revogado vencem o prazo (um convite aceito não "expira" depois). No instante exato
    /// do vencimento já não vale.
    /// </summary>
    public InviteStatus StatusAt(DateTimeOffset now)
    {
        if (UsedAt is not null)
        {
            return InviteStatus.Used;
        }

        if (RevokedAt is not null)
        {
            return InviteStatus.Revoked;
        }

        return now >= ExpiresAt ? InviteStatus.Expired : InviteStatus.Pending;
    }

    public void Revoke(DateTimeOffset now)
    {
        if (StatusAt(now) == InviteStatus.Used)
        {
            throw new InvalidOperationException("Convite já aceito: revogue a conta do convidado.");
        }

        RevokedAt ??= now;
    }
}
