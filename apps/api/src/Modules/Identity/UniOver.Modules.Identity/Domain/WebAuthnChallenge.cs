using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Domain;

/// <summary>Para que serve o desafio: cadastrar uma passkey ou confirmar uma ação perigosa.</summary>
public static class ChallengePurposes
{
    public const string Register = "register";
    public const string StepUp = "step_up";
}

/// <summary>
/// Desafio WebAuthn emitido e ainda não usado. Vale poucos minutos e uma vez só: quem o consome apaga a linha
/// com um DELETE condicional, então dois pedidos simultâneos nunca passam os dois.
/// </summary>
public sealed class WebAuthnChallenge
{
    /// <summary>O tempo do usuário para tocar o autenticador; curto para a janela de ataque ser curta.</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(2);

    // Para o EF Core materializar a linha.
    private WebAuthnChallenge()
    {
    }

    public Guid Id { get; private set; }

    public Guid UserId { get; private set; }

    public string Purpose { get; private set; } = string.Empty;

    /// <summary>Ação a confirmar (só em <c>step_up</c>); é daqui, e não do corpo da resposta, que a ação confirmada sai.</summary>
    public string? Action { get; private set; }

    /// <summary>Opções emitidas, para a verificação comparar exatamente com o que foi pedido ao autenticador.</summary>
    public string OptionsJson { get; private set; } = string.Empty;

    public DateTimeOffset ExpiresAt { get; private set; }

    public static WebAuthnChallenge Create(
        Guid userId, string purpose, string? action, string optionsJson, DateTimeOffset now)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(purpose);
        ArgumentException.ThrowIfNullOrEmpty(optionsJson);

        return new WebAuthnChallenge
        {
            Id = IdGenerator.NewId(),
            UserId = userId,
            Purpose = purpose,
            Action = action,
            OptionsJson = optionsJson,
            ExpiresAt = now + Lifetime,
        };
    }
}
