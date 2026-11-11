using System.Threading.Channels;

namespace UniOver.SharedKernel;

/// <summary>
/// Sinal em processo que acorda um laço de segundo plano antes do prazo que ele mesmo calculou. O banco do plano gratuito só
/// pode acordar quando há trabalho: em vez de um tique fixo, o laço dorme até o próximo instante útil e quem muda o trabalho
/// (criar, cancelar, reagendar, conectar, cair) chama <see cref="Notify"/>. Vários avisos juntos viram um só despertar, e um
/// aviso que chega enquanto o laço trabalha não se perde: a próxima espera o encontra e volta na hora.
/// </summary>
public sealed class WakeSignal
{
    private readonly Channel<bool> _channel = Channel.CreateBounded<bool>(
        new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });

    /// <summary>Avisa o laço. Não bloqueia e é seguro de qualquer thread; já avisado e não consumido, descarta.</summary>
    public void Notify() => _channel.Writer.TryWrite(true);

    /// <summary>
    /// Espera o aviso ou o fim de <paramref name="delay"/> (zero ou negativo não espera), o que vier primeiro, e consome os
    /// avisos acumulados. Devolve <c>true</c> se foi acordado por aviso. O relógio é o da aplicação, para o teste andar o tempo.
    /// </summary>
    public async Task<bool> WaitAsync(TimeSpan delay, TimeProvider time, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(time);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        // WaitToRead não consome o item: uma leitura pendente descartada engoliria o próximo aviso.
        var signalTask = _channel.Reader.WaitToReadAsync(linked.Token).AsTask();
        var delayTask = Task.Delay(delay > TimeSpan.Zero ? delay : TimeSpan.Zero, time, linked.Token);

        var first = await Task.WhenAny(signalTask, delayTask);
        await linked.CancelAsync();
        await IgnoreCancellationAsync(signalTask);
        await IgnoreCancellationAsync(delayTask);
        cancellationToken.ThrowIfCancellationRequested();

        var signaled = false;
        while (_channel.Reader.TryRead(out _))
        {
            signaled = true;
        }

        return signaled || ReferenceEquals(first, signalTask);
    }

    private static async Task IgnoreCancellationAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (OperationCanceledException)
        {
            // Esperado: a outra espera venceu e esta foi cancelada.
        }
    }
}
