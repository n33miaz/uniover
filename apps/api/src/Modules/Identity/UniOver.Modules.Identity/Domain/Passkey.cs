using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Domain;

/// <summary>Regras puras das passkeys: nome, contador de assinatura e a trava da última chave.</summary>
public static class PasskeyRules
{
    public const int MaxNameLength = 60;

    public const string DefaultName = "Passkey";

    /// <summary>Nome sem espaços nas pontas; nulo se vazio ou grande demais (a borda devolve 400).</summary>
    public static string? NormalizeName(string? name)
    {
        var trimmed = name?.Trim();
        return string.IsNullOrEmpty(trimmed) || trimmed.Length > MaxNameLength ? null : trimmed;
    }

    /// <summary>
    /// Não deixa remover a última passkey: sem ela o dono perderia a confirmação das ações perigosas e só
    /// voltaria a tê-la cadastrando outra antes. Por isso a regra pede que sobre ao menos uma depois da remoção.
    /// </summary>
    public static bool CanRemove(int passkeysOfUser) => passkeysOfUser > 1;

    /// <summary>
    /// O contador só pode crescer. Autenticador que não conta (iCloud, Google) manda zero sempre: zero com zero
    /// guardado vale. Contador igual ou menor que o guardado indica chave clonada.
    /// </summary>
    public static bool SignCountAdvances(long stored, long received) =>
        (stored == 0 && received == 0) || received > stored;
}

/// <summary>
/// Credencial WebAuthn do dono. Guarda só a chave pública: a privada nunca sai do aparelho. A passkey não é
/// primeiro fator; serve para confirmar ações perigosas.
/// </summary>
public sealed class Passkey
{
    // Para o EF Core materializar a linha.
    private Passkey()
    {
    }

    public Guid Id { get; private set; }

    public Guid UserId { get; private set; }

    public byte[] CredentialId { get; private set; } = [];

    public byte[] PublicKey { get; private set; } = [];

    /// <summary>Guardado como bigint: o Postgres não tem inteiro sem sinal de 32 bits.</summary>
    public long SignCount { get; private set; }

    public Guid Aaguid { get; private set; }

    public string Name { get; private set; } = PasskeyRules.DefaultName;

    /// <summary>Transportes informados no cadastro, separados por vírgula (ajudam o navegador a achar a chave).</summary>
    public string? Transports { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset? LastUsedAt { get; private set; }

    public static Passkey Create(
        Guid userId,
        byte[] credentialId,
        byte[] publicKey,
        long signCount,
        Guid aaguid,
        string name,
        string? transports,
        DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(credentialId);
        ArgumentNullException.ThrowIfNull(publicKey);
        ArgumentException.ThrowIfNullOrWhiteSpace(name);

        return new Passkey
        {
            Id = IdGenerator.NewId(),
            UserId = userId,
            CredentialId = credentialId,
            PublicKey = publicKey,
            SignCount = signCount,
            Aaguid = aaguid,
            Name = name,
            Transports = transports,
            CreatedAt = now,
        };
    }

    public void Rename(string name)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        Name = name;
    }

    public void RegisterUse(long signCount, DateTimeOffset now)
    {
        SignCount = signCount;
        LastUsedAt = now;
    }
}
