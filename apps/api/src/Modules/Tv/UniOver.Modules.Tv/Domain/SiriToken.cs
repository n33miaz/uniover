using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Domain;

/// <summary>
/// Chave pessoal dos Atalhos do iPhone (e da Siri): deixa um atalho mandar ordens à TV sem abrir o app. Vale para UMA TV e
/// só para as ações listadas em <see cref="Actions"/>; nada além disso, nem outra rota da API. No banco fica só o hash
/// (SHA-256 do texto inteiro): o texto claro sai uma única vez, na criação. A conta que criou continua dando a palavra
/// final: a permissão dela é conferida de novo a cada ordem.
/// </summary>
public sealed class SiriToken
{
    public const int NameMax = 40;
    public const int MaxActions = 40;
    public const int MaxActivePerUser = 10;
    public const int MaxExpiryDays = 365;

    private SiriToken()
    {
    }

    public Guid Id { get; private set; }

    /// <summary>Quem criou (do Identity, só o id): as ordens saem na trilha com o nome dele.</summary>
    public Guid UserId { get; private set; }

    public Guid TvId { get; private set; }

    public string Name { get; private set; } = string.Empty;

    public byte[] TokenHash { get; private set; } = [];

    /// <summary>As ações permitidas, como em <c>SiriActions</c>: <c>power_off</c>, <c>key:HOME</c>, <c>app:{id}</c>...</summary>
    public string[] Actions { get; private set; } = [];

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset? ExpiresAt { get; private set; }

    public DateTimeOffset? LastUsedAt { get; private set; }

    public DateTimeOffset? RevokedAt { get; private set; }

    public bool IsUsable(DateTimeOffset now) => RevokedAt is null && (ExpiresAt is null || ExpiresAt > now);

    public static SiriToken Create(
        Guid userId, Guid tvId, string name, byte[] tokenHash, IEnumerable<string> actions, DateTimeOffset now, DateTimeOffset? expiresAt) =>
        new()
        {
            Id = IdGenerator.NewId(),
            UserId = userId,
            TvId = tvId,
            Name = name,
            TokenHash = tokenHash,
            Actions = [.. actions],
            CreatedAt = now,
            ExpiresAt = expiresAt,
        };

    public void Revoke(DateTimeOffset now) => RevokedAt ??= now;
}

/// <summary>
/// O segredo do atalho: <c>atalho_</c> + 32 bytes aleatórios. Alta entropia, então um SHA-256 simples basta como hash (hash
/// lento só serve a segredo que gente escolhe). O prefixo ajuda a reconhecer o texto e a poupar a consulta ao banco quando
/// alguém manda lixo.
/// </summary>
public static class SiriSecrets
{
    public const string Prefix = "atalho_";

    private const int SecretBytes = 32;

    /// <summary>Texto claro (sai uma vez) e o hash que vai para o banco.</summary>
    public static (string Token, byte[] Hash) New()
    {
        var token = Prefix + Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(SecretBytes));
        return (token, Hash(token));
    }

    public static byte[] Hash(string token)
    {
        ArgumentNullException.ThrowIfNull(token);
        return SHA256.HashData(Encoding.UTF8.GetBytes(token));
    }

    /// <summary>Hash do texto apresentado; nulo se ele não tem a forma de uma chave nossa (nem chega ao banco).</summary>
    public static byte[]? HashPresented(string? token)
    {
        if (string.IsNullOrWhiteSpace(token) || token.Length > 80 || !token.StartsWith(Prefix, StringComparison.Ordinal))
        {
            return null;
        }

        try
        {
            return Base64Url.DecodeFromChars(token.AsSpan(Prefix.Length)).Length == SecretBytes ? Hash(token) : null;
        }
        catch (FormatException)
        {
            return null;
        }
    }
}
