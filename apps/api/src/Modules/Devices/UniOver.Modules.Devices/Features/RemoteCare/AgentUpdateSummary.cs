using UniOver.Modules.Devices.Contracts.Agents;

namespace UniOver.Modules.Devices.Features.RemoteCare;

/// <summary>
/// O commit que a API publicou (<c>RENDER_GIT_COMMIT</c>, quando existe) e quando ela subiu. Serve só para dizer
/// "atualização pendente" entre duas checagens do agente, que podem estar a horas uma da outra: se a API subiu depois
/// da última checagem e o commit dela é outro, o agente ainda não viu a versão nova.
/// </summary>
internal sealed record PublishedBuild(string? Commit, DateTimeOffset StartedAt);

/// <summary>
/// A auto-atualização do agente como a tela do administrador a mostra. <c>State</c> resume tudo em uma palavra estável
/// (<c>current</c>, <c>updating</c>, <c>pending</c>, <c>failed</c>, <c>blocked</c>, <c>rolled_back</c>, <c>unchecked</c>); os
/// <c>sha</c> são o commit inteiro e <c>LatestSha</c> é o mais novo que a última checagem do agente viu; só quando a API subiu depois dessa checagem com outro
/// commit é o da API (a checagem seguinte do agente confirma ou desfaz).
/// </summary>
internal sealed record AgentUpdateSummary(
    string State,
    string? InstalledSha,
    DateTimeOffset? InstalledAt,
    string? LatestSha,
    DateTimeOffset? CheckedAt,
    DateTimeOffset? NextCheckAt,
    string? Reason,
    string? BlockedSha,
    string? PreviousSha,
    bool RolledBack)
{
    public const string Current = "current";
    public const string Updating = "updating";
    public const string Pending = "pending";
    public const string Failed = "failed";
    public const string Blocked = "blocked";
    public const string RolledBackState = "rolled_back";
    public const string Unchecked = "unchecked";

    /// <summary>Nulo quando o agente nunca contou (agente antigo): a tela diz "versão desconhecida".</summary>
    public static AgentUpdateSummary? From(AgentUpdateInfo? info, PublishedBuild? build = null)
    {
        if (info is null)
        {
            return null;
        }

        var published = PublishedAheadOfTheAgent(info, build);
        var latest = published ?? info.LatestSha;
        var state = StateOf(published is null ? info : info with { LatestSha = published });
        return new AgentUpdateSummary(
            state,
            info.InstalledSha,
            info.InstalledAt,
            latest,
            info.CheckedAt,
            info.NextCheckAt,
            info.Reason,
            info.BlockedSha,
            info.PreviousSha,
            info.RolledBack);
    }

    private static bool IsSettled(AgentUpdateInfo info) =>
        info.Outcome is "updating" or "failed" or "blocked" or "rolled_back";

    /// <summary>
    /// O commit da API quando ele é mais novo do que o agente sabe: a API subiu depois da última checagem (ou ele nunca
    /// checou) e o commit dela não é o instalado. Depois de uma checagem posterior ao deploy, vale só o que o agente viu.
    /// </summary>
    private static string? PublishedAheadOfTheAgent(AgentUpdateInfo info, PublishedBuild? build)
    {
        if (build?.Commit is not { Length: 40 } commit || info.InstalledSha is null || IsSettled(info))
        {
            return null;
        }

        var agentCheckedBeforeTheDeploy = info.CheckedAt is null || info.CheckedAt < build.StartedAt;
        return agentCheckedBeforeTheDeploy && !string.Equals(commit, info.InstalledSha, StringComparison.Ordinal) ? commit : null;
    }

    private static string StateOf(AgentUpdateInfo info)
    {
        switch (info.Outcome)
        {
            case "updating":
                return Updating;
            case "failed":
                return Failed;
            case "blocked":
                return Blocked;
            case "rolled_back":
                return RolledBackState;
            default:
                break;
        }

        if (info.LatestSha is null || info.InstalledSha is null)
        {
            return info.Outcome == "not_checked" ? Unchecked : Current;
        }

        return string.Equals(info.LatestSha, info.InstalledSha, StringComparison.Ordinal) ? Current : Pending;
    }
}
