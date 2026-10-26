using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Domain;

/// <summary>Pedido vinculado à TV e ao agente do instante da criação; nunca acompanha uma troca de agente.</summary>
public sealed class PowerSchedule
{
    public const string Pending = "pending";
    public const string Dispatching = "dispatching";
    public const string Completed = "completed";
    public const string Cancelled = "cancelled";

    private PowerSchedule() { }

    public Guid Id { get; private set; }
    public Guid TvId { get; private set; }
    public string AgentSlug { get; private set; } = string.Empty;
    public Guid RequestedBy { get; private set; }
    public bool RequestedAsOwner { get; private set; }
    public DateTimeOffset DueAtUtc { get; private set; }
    public string TimeZone { get; private set; } = string.Empty;
    public string Status { get; private set; } = Pending;
    public string? Result { get; private set; }
    public string? Reason { get; private set; }
    public long Version { get; private set; } = 1;
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }
    public DateTimeOffset? LeaseUntil { get; private set; }

    public static PowerSchedule Create(Guid tvId, string agentSlug, Guid requestedBy, bool requestedAsOwner, DateTimeOffset dueAtUtc, string timeZone, DateTimeOffset now) =>
        new()
        {
            Id = IdGenerator.NewId(), TvId = tvId, AgentSlug = agentSlug, RequestedBy = requestedBy, RequestedAsOwner = requestedAsOwner,
            DueAtUtc = dueAtUtc, TimeZone = timeZone, CreatedAt = now, UpdatedAt = now,
        };

    public void Change(DateTimeOffset dueAtUtc, string timeZone, Guid requestedBy, bool requestedAsOwner, DateTimeOffset now)
    {
        DueAtUtc = dueAtUtc;
        TimeZone = timeZone;
        RequestedBy = requestedBy;
        RequestedAsOwner = requestedAsOwner;
        UpdatedAt = now;
        Version++;
    }

    public void Cancel(string reason, DateTimeOffset now)
    {
        Status = Cancelled;
        Reason = reason;
        UpdatedAt = now;
        LeaseUntil = null;
        Version++;
    }

    public void BeginDispatch(DateTimeOffset now, TimeSpan lease)
    {
        Status = Dispatching;
        LeaseUntil = now + lease;
        UpdatedAt = now;
        Version++;
    }

    public void Finish(string result, DateTimeOffset now)
    {
        Status = Completed;
        Result = result;
        LeaseUntil = null;
        UpdatedAt = now;
        Version++;
    }
}
