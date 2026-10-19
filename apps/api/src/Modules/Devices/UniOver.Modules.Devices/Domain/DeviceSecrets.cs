using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;

namespace UniOver.Modules.Devices.Domain;

/// <summary>
/// Os dois segredos do pareamento: o <c>deviceCode</c> (32 bytes, vale só durante o pareamento) e o token de
/// dispositivo (<c>uo_dev_</c> + 32 bytes). Têm alta entropia, então um SHA-256 simples basta como hash (hash
/// lento só serve a segredo que o humano escolhe). No banco vai só o hash; o texto claro sai uma vez.
/// </summary>
public static class DeviceSecrets
{
    public const string TokenPrefix = "uo_dev_";

    private const int SecretBytes = 32;

    /// <summary>Segredo do pareamento e o hash dele (SHA-256 dos 32 bytes).</summary>
    public static (string DeviceCode, byte[] Hash) NewDeviceCode()
    {
        var bytes = RandomNumberGenerator.GetBytes(SecretBytes);
        return (Base64Url.EncodeToString(bytes), SHA256.HashData(bytes));
    }

    /// <summary>Hash do <c>deviceCode</c> apresentado; nulo se o texto não tem a forma de um segredo nosso.</summary>
    public static byte[]? HashDeviceCode(string? deviceCode)
    {
        if (string.IsNullOrWhiteSpace(deviceCode) || deviceCode.Length > 64)
        {
            return null;
        }

        try
        {
            var bytes = Base64Url.DecodeFromChars(deviceCode);
            return bytes.Length == SecretBytes ? SHA256.HashData(bytes) : null;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    /// <summary>Token de dispositivo novo e o hash dele (SHA-256 do texto inteiro, prefixo incluído).</summary>
    public static (string Token, byte[] Hash) NewDeviceToken()
    {
        var token = TokenPrefix + Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(SecretBytes));
        return (token, HashToken(token));
    }

    public static byte[] HashToken(string token)
    {
        ArgumentNullException.ThrowIfNull(token);
        return SHA256.HashData(Encoding.UTF8.GetBytes(token));
    }

    /// <summary>Hash do token apresentado; nulo se não tem o formato de um token nosso (poupa a consulta ao banco).</summary>
    public static byte[]? HashPresentedToken(string? token)
    {
        if (string.IsNullOrWhiteSpace(token) || token.Length > 80 || !token.StartsWith(TokenPrefix, StringComparison.Ordinal))
        {
            return null;
        }

        try
        {
            return Base64Url.DecodeFromChars(token.AsSpan(TokenPrefix.Length)).Length == SecretBytes ? HashToken(token) : null;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    /// <summary>Comparação em tempo constante: o tempo da resposta não revela quantos bytes coincidem.</summary>
    public static bool Matches(byte[]? stored, byte[] presented)
    {
        ArgumentNullException.ThrowIfNull(presented);
        return stored is not null && CryptographicOperations.FixedTimeEquals(stored, presented);
    }
}
