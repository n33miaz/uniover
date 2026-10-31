using UniOver.BuildingBlocks.Web;
using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Domain;

/// <summary>
/// Uma conta. A do dono nasce só pelo seed da partida; a de convidado só pelo aceite de um convite do dono. Não há
/// cadastro aberto.
/// </summary>
public sealed class User
{
    // Para o EF Core materializar a linha.
    private User()
    {
    }

    public Guid Id { get; private set; }

    /// <summary>Já normalizado (<see cref="EmailRules.Normalize"/>).</summary>
    public string Email { get; private set; } = string.Empty;

    public string DisplayName { get; private set; } = string.Empty;

    public string PasswordHash { get; private set; } = string.Empty;

    public DateTimeOffset CreatedAt { get; private set; }

    public int FailedLoginCount { get; private set; }

    public DateTimeOffset? LockoutUntil { get; private set; }

    public DateTimeOffset? LastFailedAt { get; private set; }

    /// <summary><c>owner</c> ou <c>guest</c> (<see cref="AccountRoles"/>). A linha que já existia antes dos convidados é a do dono.</summary>
    public string Role { get; private set; } = AccountRoles.Owner;

    /// <summary>Quando a conta foi revogada (só convidado). Conta revogada não entra nem renova a sessão.</summary>
    public DateTimeOffset? DisabledAt { get; private set; }

    public bool IsDisabled => DisabledAt is not null;

    /// <summary>
    /// Quando a própria pessoa escolheu o nome (<see cref="DisplayNameRules"/>). Nulo = nunca escolheu: o nome é o que veio
    /// do seed ou do convite, e o app pergunta no próximo acesso.
    /// </summary>
    public DateTimeOffset? DisplayNameConfirmedAt { get; private set; }

    public bool IsDisplayNameConfirmed => DisplayNameConfirmedAt is not null;

    public static User Create(string email, string displayName, string passwordHash, DateTimeOffset now) =>
        Build(email, displayName, passwordHash, now, AccountRoles.Owner);

    /// <summary>Conta de convidado: só faz o que as permissões concedidas a ela (<see cref="UserGrant"/>) dizem.</summary>
    public static User CreateGuest(string email, string displayName, string passwordHash, DateTimeOffset now) =>
        Build(email, displayName, passwordHash, now, AccountRoles.Guest);

    private static User Build(string email, string displayName, string passwordHash, DateTimeOffset now, string role)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(email);
        ArgumentException.ThrowIfNullOrWhiteSpace(displayName);
        ArgumentException.ThrowIfNullOrEmpty(passwordHash);

        return new User
        {
            Id = IdGenerator.NewId(),
            Email = EmailRules.Normalize(email),
            DisplayName = displayName.Trim(),
            PasswordHash = passwordHash,
            CreatedAt = now,
            Role = role,
        };
    }

    /// <summary>Revoga o acesso. O dono não se revoga por aqui: só convidado.</summary>
    public void Disable(DateTimeOffset now)
    {
        if (Role != AccountRoles.Guest)
        {
            throw new InvalidOperationException("Só a conta de convidado pode ser revogada.");
        }

        DisabledAt ??= now;
    }

    /// <summary>
    /// A pessoa escolheu o nome. Confere de novo as regras (o endpoint já conferiu e mostra o erro; aqui é a trava do
    /// domínio) e grava o texto normalizado.
    /// </summary>
    /// <exception cref="ArgumentException">Nome fora das regras.</exception>
    public void SetDisplayName(string name, DateTimeOffset now)
    {
        var result = DisplayNameRules.Normalize(name);
        if (result.Value is not { } normalized)
        {
            throw new ArgumentException("Nome fora das regras.", nameof(name));
        }

        DisplayName = normalized;
        DisplayNameConfirmedAt = now;
    }

    public bool IsLockedOut(DateTimeOffset now) => LockoutUntil is { } until && until > now;

    /// <summary>Quanto falta para o bloqueio acabar (zero se não há bloqueio).</summary>
    public TimeSpan RemainingLockout(DateTimeOffset now) =>
        LockoutUntil is { } until && until > now ? until - now : TimeSpan.Zero;

    // A falha NÃO é contada aqui: somar em memória e gravar de volta perdia tentativas paralelas. O contador e o bloqueio
    // progressivo vivem em FailedLoginCounter (um UPDATE atômico no banco).

    /// <summary>O sucesso zera o contador e o bloqueio.</summary>
    public void RegisterSuccess()
    {
        FailedLoginCount = 0;
        LockoutUntil = null;
    }

    public void ReplacePasswordHash(string passwordHash)
    {
        ArgumentException.ThrowIfNullOrEmpty(passwordHash);
        PasswordHash = passwordHash;
    }
}
