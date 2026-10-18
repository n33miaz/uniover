using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Domain;

/// <summary>
/// Uma ação perigosa confirmada com a passkey, presa a uma sessão (<c>sid</c>): confirmar uma ação não libera
/// outra, e a confirmação de uma sessão não vale em outra.
/// </summary>
public sealed class StepUpConfirmation
{
    // Para o EF Core materializar a linha.
    private StepUpConfirmation()
    {
    }

    public Guid Id { get; private set; }

    public Guid UserId { get; private set; }

    public Guid SessionFamilyId { get; private set; }

    public string Action { get; private set; } = string.Empty;

    public DateTimeOffset ConfirmedAt { get; private set; }

    public DateTimeOffset ExpiresAt { get; private set; }

    public static StepUpConfirmation Create(
        Guid userId, Guid sessionFamilyId, string action, DateTimeOffset now, TimeSpan validFor)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(action);
        if (validFor <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(validFor), "A confirmação precisa valer um tempo positivo.");
        }

        return new StepUpConfirmation
        {
            Id = IdGenerator.NewId(),
            UserId = userId,
            SessionFamilyId = sessionFamilyId,
            Action = action,
            ConfirmedAt = now,
            ExpiresAt = now + validFor,
        };
    }

    /// <summary>Vale enquanto o instante for anterior ao vencimento (no instante exato do vencimento já não vale).</summary>
    public bool IsValidAt(DateTimeOffset now) => now < ExpiresAt;
}
