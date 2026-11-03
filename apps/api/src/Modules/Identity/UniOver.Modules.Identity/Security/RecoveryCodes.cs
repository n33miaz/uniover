using System.Buffers.Text;
using System.Security.Cryptography;

namespace UniOver.Modules.Identity.Security;

/// <summary>Códigos de recuperação de alta entropia; somente hashes ficam no banco.</summary>
internal static class RecoveryCodes
{
    private const int SecretBytes = 24;

    public static (string Code, byte[] Hash) Generate()
    {
        var bytes = RandomNumberGenerator.GetBytes(SecretBytes);
        return (Base64Url.EncodeToString(bytes), SHA256.HashData(bytes));
    }

    public static byte[]? Hash(string? code)
    {
        if (code is not { Length: 32 }) return null;
        try
        {
            var bytes = Base64Url.DecodeFromChars(code);
            return bytes.Length == SecretBytes ? SHA256.HashData(bytes) : null;
        }
        catch (FormatException)
        {
            return null;
        }
    }
}
