using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace UniOver.Modules.Identity.Security;

/// <summary>Códigos de seis dígitos, SHA-1 e passo de 30 s conforme RFC 6238.</summary>
internal static class TotpCodes
{
    private const int SecretLength = 20;
    private const long StepSeconds = 30;
    private const int Digits = 6;
    private const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    public static byte[] NewSecret() => RandomNumberGenerator.GetBytes(SecretLength);

    public static string ToBase32(ReadOnlySpan<byte> secret)
    {
        if (secret.Length != SecretLength) throw new ArgumentException("Segredo TOTP inválido.", nameof(secret));
        var result = new StringBuilder(32);
        var buffer = 0;
        var bits = 0;
        foreach (var value in secret)
        {
            buffer = (buffer << 8) | value;
            bits += 8;
            while (bits >= 5)
            {
                bits -= 5;
                result.Append(Alphabet[(buffer >> bits) & 31]);
            }
        }

        if (bits > 0) result.Append(Alphabet[(buffer << (5 - bits)) & 31]);
        return result.ToString();
    }

    public static string ProvisioningUri(string accountEmail, ReadOnlySpan<byte> secret)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(accountEmail);
        var label = Uri.EscapeDataString($"UniOver:{accountEmail}");
        return $"otpauth://totp/{label}?secret={ToBase32(secret)}&issuer=UniOver&algorithm=SHA1&digits={Digits}&period={StepSeconds}";
    }

    /// <summary>Retorna o passo aceito para que o chamador impeça reutilização; nulo se inválido.</summary>
    public static long? Match(ReadOnlySpan<byte> secret, string? code, DateTimeOffset now, long lastAcceptedStep = -1)
    {
        if (secret.Length != SecretLength || code is not { Length: Digits } || !code.All(char.IsAsciiDigit)) return null;
        var step = now.ToUnixTimeSeconds() / StepSeconds;
        var supplied = Encoding.ASCII.GetBytes(code);
        for (var offset = -1; offset <= 1; offset++)
        {
            var candidate = step + offset;
            if (candidate < 0 || candidate <= lastAcceptedStep) continue;
            var expected = Encoding.ASCII.GetBytes(AtStep(secret, candidate));
            if (CryptographicOperations.FixedTimeEquals(supplied, expected)) return candidate;
        }

        return null;
    }

    internal static string AtStep(ReadOnlySpan<byte> secret, long step)
    {
        if (secret.Length != SecretLength || step < 0) throw new ArgumentException("Passo TOTP inválido.");
        Span<byte> counter = stackalloc byte[8];
        BinaryPrimitives.WriteInt64BigEndian(counter, step);
        // RFC 6238 usa HMAC-SHA1 para compatibilidade com aplicativos autenticadores; HMAC não depende da resistência a colisões do hash.
#pragma warning disable CA5350
        var digest = HMACSHA1.HashData(secret, counter);
#pragma warning restore CA5350
        var offset = digest[^1] & 0x0f;
        var value = BinaryPrimitives.ReadInt32BigEndian(digest.AsSpan(offset, 4)) & 0x7fffffff;
        return (value % 1_000_000).ToString("D6", CultureInfo.InvariantCulture);
    }
}
