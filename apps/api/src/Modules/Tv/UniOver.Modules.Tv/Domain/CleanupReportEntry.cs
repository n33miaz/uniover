using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Domain;

/// <summary>Relatório imutável de uma limpeza, mantido para a tela e para comparar os efeitos ao longo do tempo.</summary>
public sealed class CleanupReportEntry
{
    public const int KindMax = 16;
    public const int TriggerMax = 40;
    public const int ResultMax = 24;
    public const int ReasonMax = 120;
    public const int AppsMax = 4000;

    private CleanupReportEntry()
    {
    }

    public Guid Id { get; private set; }
    public Guid TvId { get; private set; }
    public string Kind { get; private set; } = string.Empty;
    public string Trigger { get; private set; } = string.Empty;
    public DateTimeOffset StartedAt { get; private set; }
    public int DurationMs { get; private set; }
    public int? MemoryBeforeMb { get; private set; }
    public int? MemoryAfterMb { get; private set; }
    public int ClosedApps { get; private set; }
    public int? BackgroundProcesses { get; private set; }
    public int? SessionOpenMs { get; private set; }
    public string AppsClosed { get; private set; } = "[]";
    public string Result { get; private set; } = string.Empty;
    public string? Reason { get; private set; }

    public static CleanupReportEntry Completed(
        Guid tvId, string kind, string trigger, DateTimeOffset startedAt, int durationMs,
        int? memoryBeforeMb, int? memoryAfterMb, int closedApps, string appsClosed,
        int? backgroundProcesses = null, int? sessionOpenMs = null)
    {
        return new CleanupReportEntry
        {
            Id = IdGenerator.NewId(), TvId = tvId, Kind = Truncate(kind, KindMax)!, Trigger = Truncate(trigger, TriggerMax)!,
            StartedAt = startedAt, DurationMs = Math.Max(0, durationMs), MemoryBeforeMb = memoryBeforeMb,
            MemoryAfterMb = memoryAfterMb, ClosedApps = Math.Max(0, closedApps), AppsClosed = Truncate(appsClosed, AppsMax) ?? "[]",
            BackgroundProcesses = backgroundProcesses is null ? null : Math.Max(0, backgroundProcesses.Value),
            SessionOpenMs = sessionOpenMs is null ? null : Math.Max(0, sessionOpenMs.Value),
            Result = "completed",
        };
    }

    public static CleanupReportEntry Skipped(
        Guid tvId, string kind, string trigger, DateTimeOffset startedAt, string reason)
    {
        return new CleanupReportEntry
        {
            Id = IdGenerator.NewId(), TvId = tvId, Kind = Truncate(kind, KindMax)!, Trigger = Truncate(trigger, TriggerMax)!,
            StartedAt = startedAt, DurationMs = 0, ClosedApps = 0, Result = "skipped",
            Reason = Truncate(reason, ReasonMax),
        };
    }

    private static string? Truncate(string? value, int max) =>
        value is null ? null : value.Length <= max ? value : value[..max];
}
