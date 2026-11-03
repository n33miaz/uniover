using System.Security.Cryptography;

namespace UniOver.Modules.Identity.Security;

/// <summary>Cifra o segredo TOTP com chave exclusiva do servidor; vincula a cifra à conta.</summary>
internal sealed class TotpSecretProtector
{
    private const byte Version = 1;
    private const int NonceLength = 12;
    private const int TagLength = 16;
    private readonly byte[] key;

    public TotpSecretProtector(byte[] key)
    {
        if (key is not { Length: 32 }) throw new ArgumentException("Chave TOTP deve ter 32 bytes.", nameof(key));
        this.key = (byte[])key.Clone();
    }

    public byte[] Protect(Guid userId, ReadOnlySpan<byte> secret)
    {
        if (secret.Length != 20) throw new ArgumentException("Segredo TOTP inválido.", nameof(secret));
        var result = new byte[1 + NonceLength + TagLength + secret.Length];
        result[0] = Version;
        var nonce = result.AsSpan(1, NonceLength);
        RandomNumberGenerator.Fill(nonce);
        using var aes = new AesGcm(key, TagLength);
        aes.Encrypt(nonce, secret, result.AsSpan(1 + NonceLength + TagLength),
            result.AsSpan(1 + NonceLength, TagLength), userId.ToByteArray());
        return result;
    }

    public byte[] Unprotect(Guid userId, ReadOnlySpan<byte> encrypted)
    {
        if (encrypted.Length != 1 + NonceLength + TagLength + 20 || encrypted[0] != Version)
            throw new CryptographicException("Segredo TOTP cifrado inválido.");
        var secret = new byte[20];
        using var aes = new AesGcm(key, TagLength);
        aes.Decrypt(encrypted.Slice(1, NonceLength), encrypted.Slice(1 + NonceLength + TagLength),
            encrypted.Slice(1 + NonceLength, TagLength), secret, userId.ToByteArray());
        return secret;
    }
}
