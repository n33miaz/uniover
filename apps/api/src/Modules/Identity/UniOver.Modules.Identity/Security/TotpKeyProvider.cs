using Microsoft.Extensions.Configuration;

namespace UniOver.Modules.Identity.Security;

/// <summary>Chave da instalação para segredos TOTP; só habilita o cadastro após configurar 32 bytes em base64.</summary>
internal sealed class TotpKeyProvider
{
    private readonly TotpSecretProtector? protector;

    public TotpKeyProvider(IConfiguration configuration)
    {
        var value = configuration[IdentityModuleOptions.SectionName + ":TotpKey"];
        if (string.IsNullOrEmpty(value)) return;
        byte[] key;
        try { key = Convert.FromBase64String(value); }
        catch (FormatException) { throw new InvalidOperationException("Modules:Identity:TotpKey deve ser base64 de 32 bytes."); }
        if (key.Length != 32) throw new InvalidOperationException("Modules:Identity:TotpKey deve ter 32 bytes.");
        protector = new TotpSecretProtector(key);
    }

    public bool Available => protector is not null;
    public byte[] Protect(Guid userId, ReadOnlySpan<byte> secret) =>
        (protector ?? throw new InvalidOperationException("Chave TOTP indisponível.")).Protect(userId, secret);
    public byte[] Unprotect(Guid userId, ReadOnlySpan<byte> encrypted) =>
        (protector ?? throw new InvalidOperationException("Chave TOTP indisponível.")).Unprotect(userId, encrypted);
}
