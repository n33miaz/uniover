using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Commands;

/// <summary>Quem mandou o comando e de onde (o endpoint monta; o handler não toca no <c>HttpContext</c>).</summary>
internal sealed record TvCommandOrigin(Guid UserId, ClientInfo Client);

/// <summary>
/// O caminho comum de todo comando para a TV: escolhe o agente configurado (o salvo no app, ou a variável de reserva) e
/// o tempo limite, entrega, e deixa a linha de auditoria (inclusive quando o agente está fora do ar ou não responde).
/// Falha ao gravar a auditoria nunca impede nem desfaz o comando: vira log de erro.
/// </summary>
internal sealed partial class TvCommandRunner(
    IOptions<TvModuleOptions> options,
    ITvAgentResolver agents,
    ITvAgentPresence presence,
    ITvCommandSender sender,
    ITvStateStore state,
    ITvCommandAudit audit,
    ITvStreamPublisher stream,
    TimeProvider time,
    ILogger<TvCommandRunner> logger,
    ITvCurrentSelection? selection = null)
{
    public const string NotConfiguredCode = "agent_not_configured";

    /// <param name="command">Um valor de <see cref="TvCommandNames"/>.</param>
    /// <param name="detail">A tecla ou o pacote; do texto digitado, nunca o conteúdo.</param>
    /// <param name="waitForReply"><c>false</c> envia e segue (o <c>wake</c> não espera resposta).</param>
    /// <param name="replyTimeout">
    /// Tempo próprio de espera (a limpeza leva vários segundos); sem ele vale o padrão do módulo, que depende de a
    /// sessão com a TV estar dormindo ou não.
    /// </param>
    public async Task<TvSendOutcome> RunAsync(
        TvCommandOrigin origin,
        string command,
        string? detail,
        TvMessage message,
        bool waitForReply,
        CancellationToken cancellationToken,
        TimeSpan? replyTimeout = null)
    {
        ArgumentNullException.ThrowIfNull(origin);
        ArgumentNullException.ThrowIfNull(message);

        var settings = options.Value;
        var target = await ResolveTargetAsync(cancellationToken);
        var agentId = target.AgentSlug;

        TvSendOutcome outcome;
        if (string.IsNullOrWhiteSpace(agentId))
        {
            outcome = TvSendOutcome.Failed(TvSendStatus.NotConfigured, NotConfiguredCode);
        }
        // Falha rápida só para quem está fora há mais que a janela de reconexão do gateway: manter a requisição aberta
        // só atrasa o 503 de que a tela precisa. Dentro da janela é a queda curta de sempre (o agente volta em um ou
        // dois segundos), e o gateway espera a sessão voltar para entregar o comando.
        else if (presence.IsOfflineBeyondReconnectGrace(agentId))
        {
            outcome = TvSendOutcome.Failed(TvSendStatus.AgentOffline, AgentErrors.OfflineCode);
        }
        else if (waitForReply)
        {
            outcome = await sender.RequestAsync(
                agentId, message, replyTimeout ?? TimeoutFor(agentId, settings), cancellationToken);
        }
        else
        {
            outcome = await sender.PostAsync(agentId, message, cancellationToken);
        }

        if (outcome.Status == TvSendStatus.AgentOffline)
        {
            AnnounceOffline(target);
        }

        await RecordAsync(origin, target.Id, agentId, command, detail, outcome);
        return outcome;
    }

    /// <summary>A TV (e o agente) a que o comando desta requisição se destina: a escolhida, ou a de reserva.</summary>
    internal async ValueTask<TvTarget> ResolveTargetAsync(CancellationToken cancellationToken) =>
        selection is not null && selection.TryGet(out var selected)
            ? selected!
            : new TvTarget(Guid.Empty, (await agents.ResolveAsync(cancellationToken)).AgentSlug ?? string.Empty, ConfiguredTv.DefaultName, true);

    private TimeSpan TimeoutFor(string agentId, TvModuleOptions settings) =>
        string.Equals(state.Last(agentId)?.Connection, TvStateText.ConnectionHibernating, StringComparison.Ordinal)
            ? settings.HibernatingTimeout
            : settings.CommandTimeout;

    // A API não recebe aviso quando o agente cai; descobre ao falhar um comando e conta para a tela uma vez só.
    private void AnnounceOffline(TvTarget target)
    {
        var agentId = target.AgentSlug;
        if (state.NoteOnline(agentId, false))
        {
            stream.PublishState(target.Id, TvState.From(state.Last(agentId), agentOnline: false));
        }
    }

    private async Task RecordAsync(
        TvCommandOrigin origin, Guid tvId, string agentId, string command, string? detail, TvSendOutcome outcome)
    {
        try
        {
            var entry = CommandAuditEntry.Create(
                origin.UserId,
                string.IsNullOrWhiteSpace(agentId) ? null : agentId,
                command,
                detail,
                outcome.IsDelivered,
                outcome.IsDelivered ? null : outcome.ErrorCode ?? outcome.Status.ToString(),
                outcome.Status is TvSendStatus.NotConfigured or TvSendStatus.AgentOffline ? null : (int)outcome.Latency.TotalMilliseconds,
                origin.Client,
                time.GetUtcNow(),
                tvId);

            // Sem o token do pedido: se o cliente largou a conexão, o comando já saiu e a trilha precisa existir.
            await audit.RecordAsync(entry, CancellationToken.None);
        }
#pragma warning disable CA1031 // A auditoria não pode derrubar o comando: o erro vai para o log.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogAuditFailed(command, ex.GetType().Name);
        }
    }

    // Só o tipo do erro: a mensagem do driver do banco pode citar o servidor e a conexão.
    [LoggerMessage(Level = LogLevel.Error, Message = "Falha ao gravar a auditoria do comando {Command} ({ErrorType}).")]
    private partial void LogAuditFailed(string command, string errorType);
}
