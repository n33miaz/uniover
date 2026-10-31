using System.Text.Json.Serialization;

namespace UniOver.Modules.Tv.Domain;

/// <summary>Valores de texto do estado da TV, os mesmos do contrato com o agente e da API (minúsculas).</summary>
public static class TvStateText
{
    public const string PowerOn = "on";
    public const string PowerOff = "off";
    public const string PowerUnknown = "unknown";

    /// <summary>Sessão aberta com a TV, comandos imediatos.</summary>
    public const string ConnectionHot = "hot";

    /// <summary>Sessão dormindo para poupar a TV: o primeiro comando reconecta e demora mais. Não é "TV desligada".</summary>
    public const string ConnectionHibernating = "hibernating";

    public const string ConnectionDisconnected = "disconnected";
}

/// <summary>Última leitura do estado que o agente mandou (o volume só vive aqui, em memória).</summary>
public sealed record TvStateSnapshot(string Power, int? Volume, string? App, string Connection, DateTimeOffset UpdatedAt)
{
    /// <summary>
    /// Só <c>power</c>, <c>app</c> e <c>connection</c> valem gravação e evento: mudar apenas o volume não escreve nada
    /// (o volume muda várias vezes por segundo quando alguém segura a tecla).
    /// </summary>
    public bool SamePersistedFieldsAs(TvStateSnapshot? other) =>
        other is not null
        && string.Equals(Power, other.Power, StringComparison.Ordinal)
        && string.Equals(App, other.App, StringComparison.Ordinal)
        && string.Equals(Connection, other.Connection, StringComparison.Ordinal);
}

/// <summary>
/// O estado como a tela o vê: a leitura do agente combinada com a presença dele. <c>AgentLinked</c> diz se a TV da conta
/// tem um computador (agente) vinculado: sem vínculo não há o que ligar ou desligar, e a Início não mostra o ponto do agente.
/// </summary>
public sealed record TvState(
    string Power,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? Volume,
    string? App,
    string Connection,
    bool AgentOnline,
    DateTimeOffset? UpdatedAt,
    bool AgentLinked = true,
    DateTimeOffset? OfflineSince = null)
{
    /// <summary>
    /// Sem agente conectado não há sessão com a TV: a conexão é sempre <c>disconnected</c> e o volume (que só o
    /// agente sabe) some. Isto é calculado na leitura e nunca gravado.
    /// </summary>
    public static TvState From(TvStateSnapshot? snapshot, bool agentOnline, bool agentLinked = true, DateTimeOffset? offlineSince = null)
    {
        // `OfflineSince` só existe com o agente fora: é desde quando a tela diz "PC desligado desde...".
        var since = agentOnline ? null : offlineSince;
        if (snapshot is null)
        {
            return new TvState(TvStateText.PowerUnknown, null, null, TvStateText.ConnectionDisconnected, agentOnline, null, agentLinked, since);
        }

        return agentOnline
            ? new TvState(snapshot.Power, snapshot.Volume, snapshot.App, snapshot.Connection, true, snapshot.UpdatedAt, agentLinked)
            : new TvState(snapshot.Power, null, snapshot.App, TvStateText.ConnectionDisconnected, false, snapshot.UpdatedAt, agentLinked, since);
    }
}
