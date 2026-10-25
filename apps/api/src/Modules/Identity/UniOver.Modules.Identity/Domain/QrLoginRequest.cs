using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Domain;

/// <summary>O que a consulta do computador deve receber, decidido por regra pura (sem banco nem relógio global).</summary>
public enum QrLoginState
{
    /// <summary>Ainda esperando o celular confirmar.</summary>
    Pending,

    /// <summary>Confirmado no celular e ainda sem sessão entregue: é a hora de emitir a sessão (uma vez).</summary>
    Approved,

    /// <summary>Recusado no celular.</summary>
    Denied,

    /// <summary>Venceu, já foi entregue ou nunca existiu: para quem consulta é tudo a mesma coisa.</summary>
    Expired,
}

/// <summary>
/// Um pedido de entrada pelo QR (o computador mostra o QR, o celular já logado confirma e o computador recebe a sessão).
/// Guarda só hashes: o <c>code</c> viaja no QR (qualquer um que o veja pode APRESENTÁ-LO ao celular, mas só uma sessão
/// logada o aprova) e o <c>pollSecret</c> nunca sai do navegador que pediu; só quem o tem recebe a sessão.
/// </summary>
public sealed class QrLoginRequest
{
    /// <summary>Depois de confirmado, o computador tem este tempo para recolher a sessão (a consulta corre a cada poucos segundos).</summary>
    public static readonly TimeSpan CollectWindow = TimeSpan.FromSeconds(60);

    // Para o EF Core materializar a linha.
    private QrLoginRequest()
    {
    }

    public Guid Id { get; private set; }

    public byte[] CodeHash { get; private set; } = [];

    public byte[] PollSecretHash { get; private set; } = [];

    /// <summary>IP e aparelho do computador que pediu (a entrada anônima: texto do cliente, truncado na gravação).</summary>
    public string? RequesterIp { get; private set; }

    public string? RequesterUserAgent { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset ExpiresAt { get; private set; }

    public DateTimeOffset? ApprovedAt { get; private set; }

    /// <summary>A conta que confirmou; sem chave estrangeira, como na trilha de auditoria.</summary>
    public Guid? ApprovedBy { get; private set; }

    public string? ApproverIp { get; private set; }

    public string? ApproverUserAgent { get; private set; }

    public DateTimeOffset? DeniedAt { get; private set; }

    public DateTimeOffset? ConsumedAt { get; private set; }

    public static QrLoginRequest Create(
        byte[] codeHash,
        byte[] pollSecretHash,
        string? ip,
        string? userAgent,
        DateTimeOffset now,
        TimeSpan validFor)
    {
        ArgumentNullException.ThrowIfNull(codeHash);
        ArgumentNullException.ThrowIfNull(pollSecretHash);
        if (validFor <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(validFor), "O pedido precisa valer um tempo positivo.");
        }

        return new QrLoginRequest
        {
            Id = IdGenerator.NewId(),
            CodeHash = codeHash,
            PollSecretHash = pollSecretHash,
            RequesterIp = AuditText.Truncate(ip, AuditText.IpMax),
            RequesterUserAgent = AuditText.Truncate(userAgent, AuditText.UserAgentMax),
            CreatedAt = now,
            ExpiresAt = now + validFor,
        };
    }

    /// <summary>Vale enquanto o instante for anterior ao vencimento (no instante exato já não vale).</summary>
    public bool IsExpiredAt(DateTimeOffset now) => now >= ExpiresAt;

    /// <summary>O celular ainda pode confirmar ou recusar: no prazo e sem decisão nem sessão entregue.</summary>
    public bool IsOpenAt(DateTimeOffset now) =>
        !IsExpiredAt(now) && ApprovedAt is null && DeniedAt is null && ConsumedAt is null;

    /// <summary>
    /// A resposta da consulta. A sessão já entregue e o prazo vencido são o mesmo "expirou": quem consulta com um segredo
    /// que já valeu não aprende nada.
    /// </summary>
    public QrLoginState Evaluate(DateTimeOffset now)
    {
        if (ConsumedAt is not null || IsExpiredAt(now))
        {
            return QrLoginState.Expired;
        }

        if (DeniedAt is not null)
        {
            return QrLoginState.Denied;
        }

        return ApprovedAt is not null ? QrLoginState.Approved : QrLoginState.Pending;
    }
}
