using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Domain;

/// <summary>Segundo fator da conta. Pendente até a pessoa provar um código do autenticador.</summary>
public sealed class TotpFactor
{
    private TotpFactor() { }

    public Guid UserId { get; private set; }
    public byte[] EncryptedSecret { get; private set; } = [];
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset ExpiresAt { get; private set; }
    public DateTimeOffset? ActivatedAt { get; private set; }
    public long? LastAcceptedStep { get; private set; }

    public static TotpFactor Pending(Guid userId, byte[] encryptedSecret, DateTimeOffset now) => new()
    {
        UserId = userId,
        EncryptedSecret = (byte[])encryptedSecret.Clone(),
        CreatedAt = now,
        ExpiresAt = now.AddMinutes(10),
    };

    public bool IsActive => ActivatedAt is not null;
    public bool CanActivate(DateTimeOffset now) => !IsActive && now < ExpiresAt;

    public void Activate(long step, DateTimeOffset now)
    {
        if (!CanActivate(now)) throw new InvalidOperationException("Cadastro do autenticador vencido.");
        ActivatedAt = now;
        LastAcceptedStep = step;
    }

    public void AcceptStep(long step)
    {
        if (!IsActive || step <= LastAcceptedStep) throw new InvalidOperationException("Código já utilizado.");
        LastAcceptedStep = step;
    }
}

/// <summary>Um código de recuperação previamente entregue uma vez à pessoa; o banco só recebe o hash.</summary>
public sealed class AccountRecoveryCode
{
    private AccountRecoveryCode() { }

    public Guid Id { get; private set; }
    public Guid UserId { get; private set; }
    public byte[] CodeHash { get; private set; } = [];
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset? UsedAt { get; private set; }

    public static AccountRecoveryCode Create(Guid userId, byte[] hash, DateTimeOffset now) => new()
    {
        Id = IdGenerator.NewId(),
        UserId = userId,
        CodeHash = (byte[])hash.Clone(),
        CreatedAt = now,
    };

    public void Consume(DateTimeOffset now)
    {
        if (UsedAt is not null) throw new InvalidOperationException("Código já utilizado.");
        UsedAt = now;
    }
}

/// <summary>Pedido de redefinição enviado por e-mail: o link só contém o segredo, não o id da conta.</summary>
public sealed class PasswordResetToken
{
    private PasswordResetToken() { }

    public Guid Id { get; private set; }
    public Guid UserId { get; private set; }
    public byte[] TokenHash { get; private set; } = [];
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset ExpiresAt { get; private set; }
    public DateTimeOffset? UsedAt { get; private set; }

    public static PasswordResetToken Create(Guid userId, byte[] hash, DateTimeOffset now) => new()
    {
        Id = IdGenerator.NewId(),
        UserId = userId,
        TokenHash = (byte[])hash.Clone(),
        CreatedAt = now,
        ExpiresAt = now.AddMinutes(20),
    };

    public bool CanUse(DateTimeOffset now) => UsedAt is null && now < ExpiresAt;

    public void Consume(DateTimeOffset now)
    {
        if (!CanUse(now)) throw new InvalidOperationException("Link de recuperação inválido.");
        UsedAt = now;
    }
}
