namespace UniOver.Modules.Devices.Domain;

/// <summary>
/// Um agente pareado. O slug é o <c>agentId</c> do envelope. O hash do token só existe depois que o agente recolhe
/// o token na consulta aprovada; até lá (e depois da revogação) nenhum token vale.
/// </summary>
public sealed class Agent
{
    public const int ReasonMax = 100;

    // Para o EF Core materializar a linha.
    private Agent()
    {
    }

    public Guid Id { get; private set; }

    public string Slug { get; private set; } = string.Empty;

    public string Name { get; private set; } = string.Empty;

    public string Platform { get; private set; } = string.Empty;

    /// <summary>SHA-256 do token de dispositivo; nulo até o token ser entregue.</summary>
    public byte[]? TokenHash { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public Guid PairedBy { get; private set; }

    public DateTimeOffset? RevokedAt { get; private set; }

    public Guid? RevokedBy { get; private set; }

    public string? RevokeReason { get; private set; }

    public bool IsRevoked => RevokedAt is not null;

    /// <summary>O id é decidido por quem cria porque a aprovação o grava também no pareamento.</summary>
    public static Agent Create(Guid id, string slug, string name, string platform, Guid pairedBy, DateTimeOffset now)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        if (!AgentSlug.IsValid(slug))
        {
            throw new ArgumentException("Slug fora do padrão do envelope.", nameof(slug));
        }

        return new Agent
        {
            Id = id,
            Slug = slug,
            Name = name,
            Platform = platform,
            CreatedAt = now,
            PairedBy = pairedBy,
        };
    }

    public void IssueToken(byte[] tokenHash)
    {
        ArgumentNullException.ThrowIfNull(tokenHash);
        if (IsRevoked || TokenHash is not null)
        {
            throw new InvalidOperationException("Este agente não pode receber token.");
        }

        TokenHash = tokenHash;
    }

    /// <summary>Revoga e devolve <c>true</c>; já revogado não muda nada (a revogação é idempotente).</summary>
    public bool Revoke(DateTimeOffset now, Guid revokedBy, string? reason)
    {
        if (IsRevoked)
        {
            return false;
        }

        RevokedAt = now;
        RevokedBy = revokedBy;
        RevokeReason = AuditText.Truncate(reason, ReasonMax);
        return true;
    }
}
