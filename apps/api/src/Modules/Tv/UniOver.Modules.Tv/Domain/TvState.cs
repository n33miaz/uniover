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

/// <summary>
/// Modo da TV que o agente pode relatar em <c>tv.state</c> (campo opcional <c>mode</c>): quando ele existe, vale mais que a
/// inferência feita a partir de <c>power</c> e <c>connection</c>.
/// </summary>
public static class TvModeText
{
    public const string Off = "off";
    public const string Standby = "standby";

    /// <summary>Modo Dormir do TV Livre.</summary>
    public const string Sleep = "sleep";

    public static bool IsKnown(string? value) => value is Off or Standby or Sleep;
}

/// <summary>Valores estáveis de <c>link.state</c> (contrato <c>link.version</c> 1). Ver <c>src/Modules/Tv/UniOver.Modules.Tv/Domain/LINK-STATE.md</c>.</summary>
public static class TvLinkText
{
    /// <summary>PC desligado, sem conexão com a API ou sem relato recente do agente.</summary>
    public const string PcOffline = "pc_offline";

    public const string TvOff = "tv_off";
    public const string TvStandby = "tv_standby";
    public const string TvSleep = "tv_sleep";

    /// <summary>O PC está conectado, mas a TV não responde a ele (ou ele ainda não relatou a TV).</summary>
    public const string TvUnresponsive = "tv_unresponsive";

    public const string Ready = "ready";
}

/// <summary>
/// O elo entre a tela, o PC e a TV num valor só. Campo aditivo de <see cref="TvState"/>: o cliente que não o conhece
/// continua lendo <c>power</c>, <c>connection</c> e <c>agentOnline</c> como antes.
/// </summary>
/// <param name="Version">Versão do contrato dos valores de <paramref name="State"/>; só cresce com mudança incompatível.</param>
/// <param name="State">Um valor de <see cref="TvLinkText"/>.</param>
public sealed record TvLink(int Version, string State)
{
    public const int CurrentVersion = 1;

    /// <summary>
    /// Deriva o elo. A ordem importa: sem relato recente do agente o estado da TV não vale nada (nunca se mantém o último);
    /// depois vem o que o PC diz da conexão com a TV; por fim o modo da TV.
    /// </summary>
    /// <param name="snapshot">Última leitura que o agente mandou, ou nula.</param>
    /// <param name="agentOnline">O agente tem sessão com a API.</param>
    /// <param name="reportFresh">O agente falou dentro da janela de relato recente.</param>
    public static TvLink Derive(TvStateSnapshot? snapshot, bool agentOnline, bool reportFresh)
    {
        return new TvLink(CurrentVersion, StateOf(snapshot, agentOnline, reportFresh));
    }

    private static string StateOf(TvStateSnapshot? snapshot, bool agentOnline, bool reportFresh)
    {
        if (!agentOnline || !reportFresh)
        {
            return TvLinkText.PcOffline;
        }

        if (snapshot is null
            || snapshot.Connection is TvStateText.ConnectionDisconnected or TvStateText.ConnectionNotPaired)
        {
            return TvLinkText.TvUnresponsive;
        }

        return snapshot.Mode switch
        {
            TvModeText.Sleep => TvLinkText.TvSleep,
            TvModeText.Standby => TvLinkText.TvStandby,
            TvModeText.Off => TvLinkText.TvOff,
            _ when snapshot.Connection == TvStateText.ConnectionWaking => TvLinkText.TvStandby,
            _ when snapshot.Power == TvStateText.PowerOff => TvLinkText.TvOff,
            _ => TvLinkText.Ready,
        };
    }
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

    /// <summary>Motivo curto do agente (<c>[a-z_]</c>, até 32): o que não tem essa forma não passa para a tela.</summary>
    public static bool IsReason(string? value) =>
        !string.IsNullOrEmpty(value) && value.Length <= 32 && value.All(c => c is (>= 'a' and <= 'z') or '_');
}

/// <summary>Valores de <c>wakeHints</c>, os mesmos do contrato com o agente: avisos de ligar a TV TCL pela rede.</summary>
public static class WakeHintText
{
    /// <summary>O "Screenless service" da TV está desligado: ligar pelo celular pode não funcionar.</summary>
    public const string ScreenlessOff = "screenless_off";

    /// <summary>Ligar pela rede não deu resposta, e a TV liga sozinha quando a energia volta: tirar da tomada resolve.</summary>
    public const string Replug = "replug";

    public static bool IsKnown(string? value) => value is ScreenlessOff or Replug;
}

/// <summary>
/// Última leitura do estado que o agente mandou (o volume e a permissão do ADB só vivem aqui, em memória).
/// <c>AdbPermission</c> é <c>null</c> quando o agente não disse (Samsung, agente antigo, ADB ainda sem resposta).
/// </summary>
public sealed record TvStateSnapshot(
    string Power, int? Volume, string? App, string Connection, DateTimeOffset UpdatedAt, string? AdbPermission = null, string? AdbPermissionReason = null,
    IReadOnlyList<string>? WakeHints = null, string? Mode = null)
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
/// conectado: é o que a tela usa para pedir a permissão do ADB antes de uma ação falhar. <c>Link</c> é o estado único do
/// elo (PC, TV), aditivo: ver <c>src/Modules/Tv/UniOver.Modules.Tv/Domain/LINK-STATE.md</c>.
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
    string? AdbPermission = null,
    string? AdbPermissionReason = null,
    IReadOnlyList<string>? WakeHints = null,
    TvLink? Link = null)
{
    /// <summary>
    /// Sem agente conectado não há sessão com a TV: a conexão é sempre <c>disconnected</c> e o volume (que só o
    /// agente sabe) some. Isto é calculado na leitura e nunca gravado.
    /// </summary>
    public static TvState From(TvStateSnapshot? snapshot, bool agentOnline, bool agentLinked = true, DateTimeOffset? offlineSince = null, bool reportFresh = true)
    {
        var link = TvLink.Derive(snapshot, agentOnline, reportFresh);
        // `OfflineSince` só existe com o agente fora: é desde quando a tela diz "PC desligado desde...".
        var since = agentOnline ? null : offlineSince;
        if (snapshot is null)
        {
            return new TvState(TvStateText.PowerUnknown, null, null, TvStateText.ConnectionDisconnected, agentOnline, null, agentLinked, since, Link: link);
        }

        return agentOnline
            ? new TvState(snapshot.Power, snapshot.Volume, snapshot.App, snapshot.Connection, true, snapshot.UpdatedAt, agentLinked, null, snapshot.AdbPermission, snapshot.AdbPermissionReason, snapshot.WakeHints, link)
            : new TvState(snapshot.Power, null, snapshot.App, TvStateText.ConnectionDisconnected, false, snapshot.UpdatedAt, agentLinked, since, Link: link);
    }
}
