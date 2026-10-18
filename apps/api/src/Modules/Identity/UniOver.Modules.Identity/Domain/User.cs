using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Domain;

/// <summary>A conta única do dono. Não há cadastro: ela nasce só pelo seed da partida.</summary>
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

    public static User Create(string email, string displayName, string passwordHash, DateTimeOffset now)
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
        };
    }

    public bool IsLockedOut(DateTimeOffset now) => LockoutUntil is { } until && until > now;

    /// <summary>Quanto falta para o bloqueio acabar (zero se não há bloqueio).</summary>
    public TimeSpan RemainingLockout(DateTimeOffset now) =>
        LockoutUntil is { } until && until > now ? until - now : TimeSpan.Zero;

    /// <summary>Conta a falha e, se passou do limite, define até quando a conta fica bloqueada.</summary>
    public void RegisterFailure(DateTimeOffset now, LockoutPolicy policy)
    {
        ArgumentNullException.ThrowIfNull(policy);

        FailedLoginCount++;
        LastFailedAt = now;

        var delay = policy.DelayFor(FailedLoginCount);
        if (delay > TimeSpan.Zero)
        {
            LockoutUntil = now + delay;
        }
    }

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
