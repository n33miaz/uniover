using System.Buffers.Text;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace UniOver.Modules.Identity.Security;

/// <summary>
/// Prova de posse do aparelho para recuperar um refresh cuja resposta se perdeu. O navegador gera, a cada login, um par
/// ECDSA P-256 que não deixa exportar e manda só a chave pública; a recuperação exige uma assinatura dessa chave sobre
/// um desafio de uso único emitido pelo servidor. O cookie de refresh é <c>HttpOnly</c> (o JavaScript não o lê), então a
/// assinatura não cobre o token: ela cobre a família e o desafio, que o servidor amarra ao token no banco.
/// </summary>
internal static class DeviceProof
{
    public const string KeyHeader = "X-UniOver-Device-Key";
    public const string ChallengeHeader = "X-UniOver-Recovery-Challenge";
    public const string ProofHeader = "X-UniOver-Recovery-Proof";

    public const int KeyMaxLength = 200;

    private const string P256Oid = "1.2.840.10045.3.1.7";
    private const int NonceBytes = 32;

    /// <summary>A chave pública (SPKI em base64url) se for uma P-256 válida; nulo para qualquer outra coisa.</summary>
    public static string? NormalizeKey(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > KeyMaxLength)
        {
            return null;
        }

        try
        {
            var der = Base64Url.DecodeFromChars(value);
            using var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(der, out _);
            return key.ExportParameters(false).Curve.Oid.Value == P256Oid ? Base64Url.EncodeToString(der) : null;
        }
        catch (Exception ex) when (ex is FormatException or CryptographicException or ArgumentException)
        {
            return null;
        }
    }

    /// <summary>Nonce novo (vai para o cliente) e o hash dele (vai para o banco).</summary>
    public static (string Nonce, byte[] Hash) NewNonce()
    {
        var bytes = RandomNumberGenerator.GetBytes(NonceBytes);
        return (Base64Url.EncodeToString(bytes), SHA256.HashData(bytes));
    }

    /// <summary>O desafio que o cliente devolve (<c>id.nonce</c>); nulo se não tem a forma esperada.</summary>
    public static (Guid Id, string Nonce, byte[] NonceHash)? ParseChallenge(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 100)
        {
            return null;
        }

        var parts = value.Split('.');
        if (parts.Length != 2 || !Guid.TryParseExact(parts[0], "N", out var id))
        {
            return null;
        }

        try
        {
            var bytes = Base64Url.DecodeFromChars(parts[1]);
            return bytes.Length == NonceBytes ? (id, parts[1], SHA256.HashData(bytes)) : null;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    public static string FormatChallenge(Guid id, string nonce) => string.Create(CultureInfo.InvariantCulture, $"{id:N}.{nonce}");

    /// <summary>O que o aparelho assina: a família e o desafio (id e nonce), com rótulo e versão para não servir a outro fim.</summary>
    public static byte[] Message(Guid familyId, Guid challengeId, string nonce) =>
        Encoding.UTF8.GetBytes(string.Create(CultureInfo.InvariantCulture, $"uniover-refresh-recovery|v1|{familyId:N}|{challengeId:N}|{nonce}"));

    /// <summary>Confere a assinatura (IEEE P1363, o formato que o WebCrypto devolve) contra a chave da família.</summary>
    public static bool Verify(string publicKey, byte[] message, string? signature)
    {
        if (string.IsNullOrWhiteSpace(signature) || signature.Length > 200)
        {
            return false;
        }

        try
        {
            using var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(Base64Url.DecodeFromChars(publicKey), out _);
            return key.VerifyData(
                message,
                Base64Url.DecodeFromChars(signature),
                HashAlgorithmName.SHA256,
                DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        }
        catch (Exception ex) when (ex is FormatException or CryptographicException or ArgumentException)
        {
            return false;
        }
    }
}
