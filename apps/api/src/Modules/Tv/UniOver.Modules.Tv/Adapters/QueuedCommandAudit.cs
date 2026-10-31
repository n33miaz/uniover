using System.Threading.Channels;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;
using UniOver.SharedKernel.Diagnostics;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// A fila entre o caminho do comando e a gravação da trilha. Segurar "volume +" manda cerca de 4 teclas por segundo, e cada
/// uma gravava a auditoria (uma contagem do dia mais um INSERT) ANTES de a resposta sair: com o Neon dormindo, a primeira
/// tecla esperava o banco acordar. Agora o comando só enfileira e responde; <see cref="TvAuditWriter"/> grava depois, em
/// outro escopo e fora da requisição.
/// <para>
/// A fila é limitada: cheia (banco fora do ar por muito tempo, enchente de comandos), a linha NOVA é descartada e contada,
/// em vez de a memória do plano gratuito crescer. O teto diário por usuário já faz a trilha parar de gravar numa enchente,
/// então perder linha aqui só acontece onde a trilha já deixaria de registrar.
/// </para>
/// </summary>
internal sealed partial class TvAuditQueue(ILogger<TvAuditQueue> logger)
{
    /// <summary>Linhas aguardando gravação. Em uso normal a fila está quase sempre vazia (a gravação é mais rápida que as teclas).</summary>
    public const int Capacity = 2000;

    private readonly Channel<CommandAuditEntry> _channel = Channel.CreateBounded<CommandAuditEntry>(new BoundedChannelOptions(Capacity)
    {
        // Wait (e não DropWrite) de propósito: com DropWrite o TryWrite devolve true mesmo descartando, e a perda ficaria invisível.
        // Com Wait, TryWrite devolve false quando cheia, sem bloquear ninguém, e o chamador conta o descarte.
        FullMode = BoundedChannelFullMode.Wait,
        SingleReader = true,
    });

    private long _pending;
    private long _dropped;

    /// <summary>Linhas enfileiradas e ainda não resolvidas (gravadas, ou perdidas por falha).</summary>
    public long Pending => Interlocked.Read(ref _pending);

    /// <summary>Linhas descartadas porque a fila estava cheia, desde a partida.</summary>
    public long Dropped => Interlocked.Read(ref _dropped);

    internal ChannelReader<CommandAuditEntry> Reader => _channel.Reader;

    public bool TryEnqueue(CommandAuditEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);

        Interlocked.Increment(ref _pending);
        if (_channel.Writer.TryWrite(entry))
        {
            return true;
        }

        Interlocked.Decrement(ref _pending);
        var dropped = Interlocked.Increment(ref _dropped);

        // Um aviso na primeira e depois a cada 100: o excesso não vira enchente de log.
        if (dropped % 100 == 1)
        {
            LogDropped(dropped);
        }

        return false;
    }

    /// <summary>Marca uma linha como resolvida (gravada ou perdida por falha); só o gravador chama.</summary>
    internal void MarkDone() => Interlocked.Decrement(ref _pending);

    /// <summary>Fecha a fila para linhas novas; o gravador termina o que já está nela.</summary>
    internal void Complete() => _channel.Writer.TryComplete();

    /// <summary>Espera a fila esvaziar. Para os testes e para o encerramento; o serviço não depende disto para responder.</summary>
    public async Task DrainAsync(TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        limit.CancelAfter(timeout);
        while (Pending > 0)
        {
            await Task.Delay(5, limit.Token);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "A fila da auditoria dos comandos da TV está cheia: {Dropped} linha(s) descartada(s) desde a partida.")]
    private partial void LogDropped(long dropped);
}

/// <summary>
/// Entrega a linha à fila e volta na hora. É o que o <see cref="Features.Commands.TvCommandRunner"/> usa; as outras
/// gravações da trilha (troca do computador, edição de atalhos) continuam no <see cref="EfCommandAudit"/> síncrono, porque
/// gravam os próprios dados no mesmo <c>SaveChanges</c> e precisam da trilha ao lado.
/// </summary>
internal sealed class QueuedCommandAudit(TvAuditQueue queue) : ITvCommandAudit
{
    public Task RecordAsync(CommandAuditEntry entry, CancellationToken cancellationToken)
    {
        queue.TryEnqueue(entry);
        return Task.CompletedTask;
    }
}

/// <summary>
/// Grava a fila no banco, uma linha por vez, cada uma no próprio escopo (um contexto novo: uma falha não contamina a
/// seguinte). Falha vira log com o TIPO do erro e a linha se perde, como a falha de auditoria sempre foi: a trilha nunca
/// derruba nem desfaz o comando. Ao encerrar, o que já estava na fila ainda é gravado.
/// </summary>
internal sealed partial class TvAuditWriter(IServiceScopeFactory scopes, TvAuditQueue queue, ILogger<TvAuditWriter> logger) : BackgroundService
{
    /// <summary>Teto de uma gravação: cobre o despertar do banco com folga e impede um banco travado de prender o encerramento.</summary>
    private static readonly TimeSpan WriteTimeout = TimeSpan.FromSeconds(20);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Lê até a fila ser fechada (StopAsync), e não até o cancelamento: o que já entrou ainda precisa ser gravado.
        await foreach (var entry in queue.Reader.ReadAllAsync(CancellationToken.None))
        {
            await WriteAsync(entry);
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        queue.Complete();
        await base.StopAsync(cancellationToken);
    }

    private async Task WriteAsync(CommandAuditEntry entry)
    {
        try
        {
            using var limit = new CancellationTokenSource(WriteTimeout);
            await using var scope = scopes.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<ITvCommandAudit>().RecordAsync(entry, limit.Token);
        }
#pragma warning disable CA1031 // A trilha não pode derrubar o gravador: o erro vai para o log como tipo.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogWriteFailed(entry.Command, ErrorDetail.Stack(ex));
        }
        finally
        {
            queue.MarkDone();
        }
    }

    // Tipo e pilha, nunca a mensagem: a mensagem do driver do banco pode citar o servidor e a conexão.
    [LoggerMessage(Level = LogLevel.Error, Message = "Falha ao gravar a auditoria do comando {Command} ({Error}).")]
    private partial void LogWriteFailed(string command, string error);
}
