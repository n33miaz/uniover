using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Domain;

/// <summary>Registro permanente da remoção de uma TV. Não tem FK para a TV porque a linha é a evidência de que ela existiu.</summary>
public sealed class TvRemovalAuditEntry
{
    private TvRemovalAuditEntry()
    {
    }

    public Guid Id { get; private set; }
    public Guid TvId { get; private set; }
    public Guid UserId { get; private set; }
    public string AgentId { get; private set; } = string.Empty;
    public string Kind { get; private set; } = string.Empty;
    public string? Ip { get; private set; }
    public string? UserAgent { get; private set; }
    public DateTimeOffset OccurredAt { get; private set; }

    public static TvRemovalAuditEntry Create(
        Guid tvId, Guid userId, string agentId, string kind, ClientInfo client, DateTimeOffset occurredAt) =>
        new()
        {
            Id = IdGenerator.NewId(),
            TvId = tvId,
            UserId = userId,
            AgentId = Truncate(agentId, CommandAuditEntry.AgentMax) ?? string.Empty,
            Kind = Truncate(kind, 20) ?? "unknown",
            Ip = Truncate(client.Ip, CommandAuditEntry.IpMax),
            UserAgent = Truncate(client.UserAgent, CommandAuditEntry.UserAgentMax),
            OccurredAt = occurredAt,
        };

    private static string? Truncate(string? value, int max) =>
        value is null ? null : value.Length <= max ? value : value[..max];
}
