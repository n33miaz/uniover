using System.Buffers.Text;
using System.Security.Cryptography;

namespace UniOver.Modules.Identity.Security;

/// <summary>Segredo opaco do refresh: 32 bytes aleatórios; no banco só o SHA-256 dele.</summary>
internal static class SecretTokens
{
    private const int SecretBytes = 32;

    /// <summary>Segredo (vai para o cookie) e o hash (vai para o banco).</summary>
    public static (string Secret, byte[] Hash) Generate()
    {
        var bytes = RandomNumberGenerator.GetBytes(SecretBytes);
        return (Base64Url.EncodeToString(bytes), SHA256.HashData(bytes));
    }

    /// <summary>Hash do segredo apresentado; nulo se o texto não tem a forma de um segredo nosso.</summary>
    public static byte[]? Hash(string? secret)
    {
        if (string.IsNullOrWhiteSpace(secret) || secret.Length > 64)
        {
            return null;
        }

        try
        {
            var bytes = Base64Url.DecodeFromChars(secret);
            return bytes.Length == SecretBytes ? SHA256.HashData(bytes) : null;
        }
        catch (FormatException)
        {
            return null;
        }
    }
}
