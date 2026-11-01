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

/// <summary>Se um token já girado pode ser recuperado (a recuperação ainda confere sucessor, chave e prova).</summary>
public enum RecoveryEligibility
{
    NotRotated,
    OutsideWindow,
    AlreadyRecovered,
    Eligible,
}

/// <summary>Tempos do refresh: janela deslizante, teto absoluto da família e tolerância de reuso.</summary>
public sealed record RefreshPolicy(
    TimeSpan SlidingWindow,
    TimeSpan AbsoluteLifetime,
    TimeSpan ReuseGrace,
    TimeSpan RecoveryWindow = default,
    TimeSpan ChallengeLifetime = default)
{
    /// <summary>
    /// Tempo, depois da rotação, em que o mesmo aparelho ainda pode reapresentar o token antigo, provando a chave da
    /// família, se o sucessor nunca foi usado: cobre a resposta perdida (o iPhone suspendeu a página no meio da
    /// requisição e o cookie novo não chegou). Zero desliga a recuperação.
    /// </summary>
    public static readonly TimeSpan DefaultRecoveryWindow = TimeSpan.FromMinutes(10);

    /// <summary>Validade do desafio de uso único que o servidor emite para a prova.</summary>
    public static readonly TimeSpan DefaultChallengeLifetime = TimeSpan.FromMinutes(2);

    public static RefreshPolicy Default { get; } =
        new(TimeSpan.FromDays(14), TimeSpan.FromDays(90), TimeSpan.FromSeconds(3), DefaultRecoveryWindow, DefaultChallengeLifetime);

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

    /// <summary>
    /// Preenchido quando este token foi o apresentado numa recuperação, ou o sucessor que ela consumiu: nenhum dos dois
    /// recupera de novo (uma recuperação por token girado, nunca em cadeia).
    /// </summary>
    public DateTimeOffset? RecoveredAt { get; private set; }

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

    /// <summary>
    /// Girado há pouco, não revogado e ainda sem recuperação: candidato a recuperar (o chamador confere o sucessor, a
    /// chave da família e a prova). Revogado, nunca girado, fora da janela ou já recuperado não é.
    /// </summary>
    public RecoveryEligibility Eligibility(DateTimeOffset now, TimeSpan recoveryWindow)
    {
        if (RevokedAt is not null || ReplacedById is null || UsedAt is not { } usedAt)
        {
            return RecoveryEligibility.NotRotated;
        }

        if (recoveryWindow <= TimeSpan.Zero || now - usedAt > recoveryWindow)
        {
            return RecoveryEligibility.OutsideWindow;
        }

        return RecoveredAt is null ? RecoveryEligibility.Eligible : RecoveryEligibility.AlreadyRecovered;
    }

    /// <summary>Marca a recuperação (apresentado e consumido): ver <see cref="RecoveredAt"/>.</summary>
    public void MarkRecovered(DateTimeOffset now) => RecoveredAt = now;

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
    public const string GuestRevoked = "guest-revoked";
    public const string GuestPaused = "guest-paused";
    public const string SessionRevoked = "session-revoked";
}
