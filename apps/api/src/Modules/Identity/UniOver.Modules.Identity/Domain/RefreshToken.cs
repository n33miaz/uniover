using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Domain;

/// <summary>O que fazer com um refresh apresentado.</summary>
public enum RefreshDecision
{
    /// <summary>Pode girar: marcar como usado e emitir o próximo.</summary>
    Valid,

    /// <summary>Nunca foi usado, mas já venceu.</summary>
    Expired,

    /// <summary>Já foi usado há instantes (duas abas girando juntas): não revoga, o cliente tenta de novo.</summary>
    Conflict,

    /// <summary>Usado fora da tolerância ou revogado: sinal de roubo, revoga a família inteira.</summary>
    Reuse,
}

/// <summary>Tempos do refresh: janela deslizante, teto absoluto da família e tolerância de reuso.</summary>
public sealed record RefreshPolicy(TimeSpan SlidingWindow, TimeSpan AbsoluteLifetime, TimeSpan ReuseGrace)
{
    public static RefreshPolicy Default { get; } =
        new(TimeSpan.FromDays(14), TimeSpan.FromDays(90), TimeSpan.FromSeconds(3));

    /// <summary>Vencimento do próximo token: janela deslizante, mas nunca depois do teto da família.</summary>
    public DateTimeOffset ExpiryFor(DateTimeOffset now, DateTimeOffset familyStartedAt)
    {
        var sliding = now + SlidingWindow;
        var ceiling = familyStartedAt + AbsoluteLifetime;
        return sliding < ceiling ? sliding : ceiling;
    }

    public bool FamilyExpired(DateTimeOffset now, DateTimeOffset familyStartedAt) =>
        now >= familyStartedAt + AbsoluteLifetime;
}

/// <summary>
/// Um refresh opaco. O segredo nunca é gravado: só o SHA-256 dele. Cada uso gira o token dentro da mesma
/// família; apresentar de novo um token já girado revela que alguém guardou uma cópia.
/// </summary>
public sealed class RefreshToken
{
    // Para o EF Core materializar a linha.
    private RefreshToken()
    {
    }

    public Guid Id { get; private set; }

    public Guid UserId { get; private set; }

    public Guid FamilyId { get; private set; }

    public byte[] TokenHash { get; private set; } = [];

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset ExpiresAt { get; private set; }

    public DateTimeOffset? UsedAt { get; private set; }

    public Guid? ReplacedById { get; private set; }

    public DateTimeOffset? RevokedAt { get; private set; }

    public string? RevokedReason { get; private set; }

    public string? Ip { get; private set; }

    public string? UserAgent { get; private set; }

    public static RefreshToken Create(
        Guid userId,
        Guid familyId,
        byte[] tokenHash,
        DateTimeOffset now,
        DateTimeOffset expiresAt,
        string? ip,
        string? userAgent)
    {
        ArgumentNullException.ThrowIfNull(tokenHash);

        return new RefreshToken
        {
            Id = IdGenerator.NewId(),
            UserId = userId,
            FamilyId = familyId,
            TokenHash = tokenHash,
            CreatedAt = now,
            ExpiresAt = expiresAt,
            Ip = AuditText.Truncate(ip, AuditText.IpMax),
            UserAgent = AuditText.Truncate(userAgent, AuditText.UserAgentMax),
        };
    }

    public RefreshDecision Evaluate(DateTimeOffset now, TimeSpan reuseGrace)
    {
        if (RevokedAt is not null)
        {
            return RefreshDecision.Reuse;
        }

        if (UsedAt is { } usedAt)
        {
            return now - usedAt <= reuseGrace ? RefreshDecision.Conflict : RefreshDecision.Reuse;
        }

        return ExpiresAt <= now ? RefreshDecision.Expired : RefreshDecision.Valid;
    }

    /// <summary>Gira: este token fica usado e aponta para o sucessor.</summary>
    public void MarkRotated(DateTimeOffset now, Guid replacedById)
    {
        UsedAt = now;
        ReplacedById = replacedById;
    }

    /// <summary>Revoga (idempotente: o primeiro motivo fica).</summary>
    public void Revoke(DateTimeOffset now, string reason)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(reason);
        if (RevokedAt is not null)
        {
            return;
        }

        RevokedAt = now;
        RevokedReason = reason;
    }
}

/// <summary>Motivos gravados em <c>revoked_reason</c>.</summary>
public static class RevokeReasons
{
    public const string Reuse = "reuse";
    public const string Logout = "logout";
}
