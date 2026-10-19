namespace UniOver.Modules.Tv.Domain;

/// <summary>Último estado gravado de uma TV (uma linha por agente): só <c>power</c>, <c>app</c> e <c>connection</c>.</summary>
public sealed class TvStateRecord
{
    public const int AgentMax = 40;
    public const int AppMax = 255;

    // Para o EF Core materializar a linha.
    private TvStateRecord()
    {
    }

    public string AgentId { get; private set; } = string.Empty;

    public string Power { get; private set; } = string.Empty;

    public string? App { get; private set; }

    public string Connection { get; private set; } = string.Empty;

    public DateTimeOffset UpdatedAt { get; private set; }

    public static TvStateRecord Create(string agentId, TvStateSnapshot snapshot)
    {
        var record = new TvStateRecord { AgentId = agentId };
        record.Update(snapshot);
        return record;
    }

    /// <summary>
    /// A linha já guarda estes mesmos valores? Depois de um reinício da API a memória está vazia: sem esta conferência,
    /// o primeiro estado que o agente manda ao reconectar viraria uma "mudança" falsa a cada vez que o serviço acorda.
    /// </summary>
    public bool Matches(TvStateSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        return string.Equals(Power, snapshot.Power, StringComparison.Ordinal)
            && string.Equals(App, ClipApp(snapshot.App), StringComparison.Ordinal)
            && string.Equals(Connection, snapshot.Connection, StringComparison.Ordinal);
    }

    public void Update(TvStateSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        Power = snapshot.Power;
        App = ClipApp(snapshot.App);
        Connection = snapshot.Connection;
        UpdatedAt = snapshot.UpdatedAt;
    }

    private static string? ClipApp(string? app) => app is { Length: > AppMax } ? app[..AppMax] : app;
}
