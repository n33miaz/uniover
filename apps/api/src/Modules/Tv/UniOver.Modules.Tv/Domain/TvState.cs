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

    public const string ConnectionNotPaired = "not_paired";

    /// <summary>
    /// O agente está abrindo a sessão e a TV ainda não respondeu (acordando do standby). É passageiro: a tela mostra "TV ligando"
    /// em vez de um erro, e a API não o grava.
    /// </summary>
    public const string ConnectionWaking = "waking";
}

/// <summary>Valores de <c>adbPermission</c>, os mesmos do contrato com o agente (minúsculas).</summary>
public static class AdbPermissionText
{
    /// <summary>A TV aceitou o UniOver no ADB.</summary>
    public const string Granted = "granted";

    /// <summary>O agente não consegue usar o ADB sem a pessoa pedir pelo app.</summary>
    public const string Missing = "missing";

    /// <summary>O aviso do ADB está na tela da TV esperando o aceite.</summary>
    public const string Pending = "pending";

    public static bool IsKnown(string? value) => value is Granted or Missing or Pending;
}

/// <summary>
/// Última leitura do estado que o agente mandou (o volume e a permissão do ADB só vivem aqui, em memória).
/// <c>AdbPermission</c> é <c>null</c> quando o agente não disse (Samsung, agente antigo, ADB ainda sem resposta).
/// </summary>
public sealed record TvStateSnapshot(
    string Power, int? Volume, string? App, string Connection, DateTimeOffset UpdatedAt, string? AdbPermission = null)
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
/// <c>AdbPermission</c> (<c>granted</c>, <c>missing</c>, <c>pending</c> ou <c>null</c> se não se sabe) só existe com o agente
/// conectado: é o que a tela usa para pedir a permissão do ADB antes de uma ação falhar.
/// </summary>
public sealed record TvState(
    string Power,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? Volume,
    string? App,
    string Connection,
    bool AgentOnline,
    DateTimeOffset? UpdatedAt,
    bool AgentLinked = true,
    DateTimeOffset? OfflineSince = null,
    string? AdbPermission = null)
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
            ? new TvState(snapshot.Power, snapshot.Volume, snapshot.App, snapshot.Connection, true, snapshot.UpdatedAt, agentLinked, null, snapshot.AdbPermission)
            : new TvState(snapshot.Power, null, snapshot.App, TvStateText.ConnectionDisconnected, false, snapshot.UpdatedAt, agentLinked, since);
    }
}
