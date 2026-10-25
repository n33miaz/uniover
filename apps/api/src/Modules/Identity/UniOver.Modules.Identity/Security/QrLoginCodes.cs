using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;

namespace UniOver.Modules.Identity.Security;

/// <summary>
/// O código público do QR: 12 bytes aleatórios (96 bits) em 16 caracteres base64url, curto o bastante para um QR pequeno
/// e longo demais para ser adivinhado. No banco vai só o SHA-256 do texto. O segredo de consulta usa o formato do refresh
/// (<see cref="SecretTokens"/>).
/// </summary>
internal static class QrLoginCodes
{
    private const int CodeBytes = 12;
    public const int CodeLength = 16;

    public static (string Code, byte[] Hash) NewCode()
    {
        var code = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(CodeBytes));
        return (code, SHA256.HashData(Encoding.ASCII.GetBytes(code)));
    }

    /// <summary>Hash do código apresentado; nulo se o texto não tem a forma de um código nosso.</summary>
    public static byte[]? Hash(string? code)
    {
        if (code is not { Length: CodeLength } || !code.All(IsBase64UrlChar))
        {
            return null;
        }

        return SHA256.HashData(Encoding.ASCII.GetBytes(code));
    }

    private static bool IsBase64UrlChar(char c) =>
        c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '-' or '_';
}
