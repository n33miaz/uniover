using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Domain;

/// <summary>
/// Chave pública do aparelho que abriu a sessão (uma por família). O navegador gera o par ECDSA P-256 no momento do
/// login, não exportável, e só a pública chega aqui. Nunca é trocada: uma família sem chave não recupera refresh.
/// </summary>
public sealed class RefreshDeviceKey
{
    private RefreshDeviceKey()
    {
    }

    public Guid FamilyId { get; private set; }

    public Guid UserId { get; private set; }

    /// <summary>SPKI em base64url.</summary>
    public string PublicKey { get; private set; } = string.Empty;

    public DateTimeOffset CreatedAt { get; private set; }

    public static RefreshDeviceKey Create(Guid familyId, Guid userId, string publicKey, DateTimeOffset now) =>
        new() { FamilyId = familyId, UserId = userId, PublicKey = publicKey, CreatedAt = now };
}

/// <summary>
/// Desafio de uso único da recuperação: o servidor emite o nonce (só o SHA-256 dele é guardado) para um token já
/// girado de uma família; o aparelho o assina junto com a família e o id do desafio. Consumido por um UPDATE condicional,
/// nunca vale duas vezes.
/// </summary>
public sealed class RefreshRecoveryChallenge
{
    private RefreshRecoveryChallenge()
    {
    }

    public Guid Id { get; private set; }

    public Guid FamilyId { get; private set; }

    /// <summary>O token (já girado) para o qual o desafio foi emitido: outro token não o consome.</summary>
    public Guid TokenId { get; private set; }

    public byte[] NonceHash { get; private set; } = [];

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset ExpiresAt { get; private set; }

    public DateTimeOffset? ConsumedAt { get; private set; }

    public static RefreshRecoveryChallenge Create(
        Guid familyId, Guid tokenId, byte[] nonceHash, DateTimeOffset now, TimeSpan lifetime)
    {
        ArgumentNullException.ThrowIfNull(nonceHash);
        return new RefreshRecoveryChallenge
        {
            Id = IdGenerator.NewId(),
            FamilyId = familyId,
            TokenId = tokenId,
            NonceHash = nonceHash,
            CreatedAt = now,
            ExpiresAt = now + lifetime,
        };
    }
}
