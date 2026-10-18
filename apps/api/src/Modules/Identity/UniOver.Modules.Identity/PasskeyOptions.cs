namespace UniOver.Modules.Identity;

/// <summary>
/// Dados da parte confiável do WebAuthn (<c>Modules:Identity:Passkeys</c>). <see cref="RpId"/> e
/// <see cref="Origins"/> vêm do ambiente: a passkey fica presa ao domínio, e trocar de domínio exige recadastrar.
/// </summary>
public sealed class PasskeyOptions
{
    public const string SectionName = "Modules:Identity:Passkeys";

    /// <summary>Host completo do app (ex.: <c>uniover.onrender.com</c>), nunca só o sufixo público.</summary>
    public string? RpId { get; set; }

    /// <summary>Origens aceitas no <c>clientDataJSON</c> (ex.: <c>https://uniover.onrender.com</c>).</summary>
    public string[] Origins { get; set; } = [];

    /// <summary>Nome mostrado pelo sistema ao cadastrar a passkey.</summary>
    public string ServerName { get; set; } = "UniOver";
}

/// <summary>Quanto tempo uma confirmação vale (<c>Modules:Identity:StepUp</c>).</summary>
public sealed class StepUpOptions
{
    public const string SectionName = "Modules:Identity:StepUp";

    /// <summary>Minutos de validade da confirmação de uma ação; curto de propósito: não é a sessão.</summary>
    public int Minutes { get; set; } = 5;

    public TimeSpan Validity => TimeSpan.FromMinutes(Minutes);

    internal static bool IsValid(StepUpOptions o) => o.Minutes is >= 1 and <= 60;
}
