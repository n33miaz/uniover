using UniOver.Modules.Devices.Contracts.Agents;

namespace UniOver.Modules.Devices.Domain;

/// <summary>
/// A última informação que um agente contou e que deve sobreviver à instância da API. A conexão viva continua fora
/// do banco; esta linha só descreve o último estado conhecido para a tela enquanto o computador está desligado.
/// </summary>
public sealed class AgentPresenceSnapshot
{
    public const int UpdateOutcomeMax = 20;
    public const int ShaMax = 64;
    public const int UpdateReasonMax = 200;

    private AgentPresenceSnapshot()
    {
    }

    private AgentPresenceSnapshot(Guid agentId)
    {
        AgentId = agentId;
    }

    public Guid AgentId { get; private set; }

    public DateTimeOffset? LastSeenAt { get; private set; }

    public string? AgentVersion { get; private set; }

    public string? Os { get; private set; }

    public string? TvKind { get; private set; }

    public string? TvHost { get; private set; }

    public string? UpdateOutcome { get; private set; }

    public string? InstalledSha { get; private set; }

    public DateTimeOffset? InstalledAt { get; private set; }

    public string? LatestSha { get; private set; }

    public DateTimeOffset? CheckedAt { get; private set; }

    public DateTimeOffset? NextCheckAt { get; private set; }

    public string? UpdateReason { get; private set; }

    public string? BlockedSha { get; private set; }

    public string? PreviousSha { get; private set; }

    public bool RolledBack { get; private set; }

    public static AgentPresenceSnapshot Create(Guid agentId) => new(agentId);

    public void RecordLastSeen(DateTimeOffset now) => LastSeenAt = now;

    public void RecordHello(string agentVersion, AgentHostInfo? host)
    {
        AgentVersion = agentVersion;
        Os = host?.Os;
        TvKind = host?.TvKind;
        TvHost = host?.TvHost;
    }

    public void RecordUpdate(AgentUpdateInfo update)
    {
        ArgumentNullException.ThrowIfNull(update);
        UpdateOutcome = update.Outcome;
        InstalledSha = update.InstalledSha;
        InstalledAt = update.InstalledAt;
        LatestSha = update.LatestSha;
        CheckedAt = update.CheckedAt;
        NextCheckAt = update.NextCheckAt;
        UpdateReason = update.Reason;
        BlockedSha = update.BlockedSha;
        PreviousSha = update.PreviousSha;
        RolledBack = update.RolledBack;
    }

    public AgentHostInfo? Host => Os is null && TvKind is null ? null : new AgentHostInfo(Os, TvKind, TvHost);

    public AgentUpdateInfo? Update => UpdateOutcome is null
        ? null
        : new AgentUpdateInfo(
            UpdateOutcome,
            InstalledSha,
            InstalledAt,
            LatestSha,
            CheckedAt,
            NextCheckAt,
            UpdateReason,
            BlockedSha,
            PreviousSha,
            RolledBack);
}
