using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Commands;

/// <summary>Quem mandou o comando e de onde (o endpoint monta; o handler não toca no <c>HttpContext</c>).</summary>
internal sealed record TvCommandOrigin(Guid UserId, ClientInfo Client);

/// <summary>
/// O caminho comum de todo comando para a TV: escolhe o agente configurado e o tempo limite, entrega, e deixa a
/// linha de auditoria (inclusive quando o agente está fora do ar ou não responde). Falha ao gravar a auditoria
/// nunca impede nem desfaz o comando: vira log de erro.
/// </summary>
internal sealed partial class TvCommandRunner(
    IOptions<TvModuleOptions> options,
    ITvCommandSender sender,
    ITvStateStore state,
    ITvCommandAudit audit,
    ITvStreamPublisher stream,
    TimeProvider time,
    ILogger<TvCommandRunner> logger)
{
    public const string NotConfiguredCode = "agent_not_configured";

    /// <param name="command">Um valor de <see cref="TvCommandNames"/>.</param>
    /// <param name="detail">A tecla ou o pacote; do texto digitado, nunca o conteúdo.</param>
    /// <param name="waitForReply"><c>false</c> envia e segue (o <c>wake</c> não espera resposta).</param>
    public async Task<TvSendOutcome> RunAsync(
        TvCommandOrigin origin,
        string command,
        string? detail,
        TvMessage message,
        bool waitForReply,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(origin);
        ArgumentNullException.ThrowIfNull(message);

        var settings = options.Value;
        var agentId = settings.AgentId;

        TvSendOutcome outcome;
        if (string.IsNullOrWhiteSpace(agentId))
        {
            outcome = TvSendOutcome.Failed(TvSendStatus.NotConfigured, NotConfiguredCode);
        }
        else if (waitForReply)
        {
            outcome = await sender.RequestAsync(agentId, message, TimeoutFor(agentId, settings), cancellationToken);
        }
        else
        {
            outcome = await sender.PostAsync(agentId, message, cancellationToken);
        }

        if (outcome.Status == TvSendStatus.AgentOffline)
        {
            AnnounceOffline(agentId);
        }

        await RecordAsync(origin, agentId, command, detail, outcome);
        return outcome;
    }

    private TimeSpan TimeoutFor(string agentId, TvModuleOptions settings) =>
        string.Equals(state.Last(agentId)?.Connection, TvStateText.ConnectionHibernating, StringComparison.Ordinal)
            ? settings.HibernatingTimeout
            : settings.CommandTimeout;

    // A API não recebe aviso quando o agente cai; descobre ao falhar um comando e conta para a tela uma vez só.
    private void AnnounceOffline(string agentId)
    {
        if (state.NoteOnline(agentId, false))
        {
            stream.PublishState(TvState.From(state.Last(agentId), agentOnline: false));
        }
    }

    private async Task RecordAsync(
        TvCommandOrigin origin, string agentId, string command, string? detail, TvSendOutcome outcome)
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
                time.GetUtcNow());

            // Sem o token do pedido: se o cliente largou a conexão, o comando já saiu e a trilha precisa existir.
            await audit.RecordAsync(entry, CancellationToken.None);
        }
#pragma warning disable CA1031 // A auditoria não pode derrubar o comando: o erro vai para o log.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogAuditFailed(command, ex);
        }
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Falha ao gravar a auditoria do comando {Command}.")]
    private partial void LogAuditFailed(string command, Exception exception);
}
