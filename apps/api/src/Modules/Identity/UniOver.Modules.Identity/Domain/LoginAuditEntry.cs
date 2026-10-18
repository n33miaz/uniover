using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Domain;

/// <summary>Limites de texto da auditoria (a entrada vem do cliente e não pode inflar a tabela).</summary>
public static class AuditText
{
    public const int IpMax = 64;
    public const int UserAgentMax = 256;
    public const int DetailMax = 200;

    public static string? Truncate(string? value, int max) =>
        value is null ? null : value.Length <= max ? value : value[..max];
}

/// <summary>
/// Uma linha da trilha de auditoria. Nunca guarda senha, token, hash nem o e-mail digitado: o
/// <c>detail</c> é um código curto escolhido pelo servidor.
/// </summary>
public sealed class LoginAuditEntry
{
    // Para o EF Core materializar a linha.
    private LoginAuditEntry()
    {
    }

    public Guid Id { get; private set; }

    /// <summary>Nulo quando o e-mail não existe: a tentativa não revela nada sobre contas.</summary>
    public Guid? UserId { get; private set; }

    public string Event { get; private set; } = string.Empty;

    public DateTimeOffset OccurredAt { get; private set; }

    public string? Ip { get; private set; }

    public string? UserAgent { get; private set; }

    public string? Detail { get; private set; }

    public static LoginAuditEntry Create(
        Guid? userId,
        string eventName,
        DateTimeOffset occurredAt,
        string? ip,
        string? userAgent,
        string? detail = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(eventName);

        return new LoginAuditEntry
        {
            Id = IdGenerator.NewId(),
            UserId = userId,
            Event = eventName,
            OccurredAt = occurredAt,
            Ip = AuditText.Truncate(ip, AuditText.IpMax),
            UserAgent = AuditText.Truncate(userAgent, AuditText.UserAgentMax),
            Detail = AuditText.Truncate(detail, AuditText.DetailMax),
        };
    }
}
