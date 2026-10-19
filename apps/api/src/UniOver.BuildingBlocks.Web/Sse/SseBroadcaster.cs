using System.Text.RegularExpressions;
using System.Threading.Channels;

namespace UniOver.BuildingBlocks.Web;

/// <summary>Um evento SSE: o nome (<c>event:</c>) e o dado, que vai como JSON em uma linha só.</summary>
public sealed record SseMessage<T>(string EventType, T Data);

/// <summary>
/// Um assinante do <see cref="SseBroadcaster{T}"/>: a fila própria dele. A fila é limitada: quem não acompanha é
/// fechado em vez de segurar memória, e ao reabrir recebe o instantâneo de novo.
/// </summary>
public sealed class SseSubscription<T> : IDisposable
{
    private readonly Channel<SseMessage<T>> _channel;
    private readonly Action<SseSubscription<T>> _onClosed;
    private int _closed;

    internal SseSubscription(string owner, int capacity, Action<SseSubscription<T>> onClosed)
    {
        Owner = owner;
        _onClosed = onClosed;
        _channel = Channel.CreateBounded<SseMessage<T>>(new BoundedChannelOptions(capacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait,
        });
    }

    /// <summary>Dono do fluxo (o usuário), para o limite por usuário.</summary>
    public string Owner { get; }

    public ChannelReader<SseMessage<T>> Reader => _channel.Reader;

    /// <summary><c>false</c> quando a fila está cheia ou o fluxo já foi fechado.</summary>
    internal bool TryEnqueue(SseMessage<T> message) => _channel.Writer.TryWrite(message);

    /// <summary>Encerra o fluxo: quem lê a fila termina depois de esvaziá-la. Pode ser chamado mais de uma vez.</summary>
    public void Close()
    {
        if (Interlocked.Exchange(ref _closed, 1) == 0)
        {
            _channel.Writer.TryComplete();
            _onClosed(this);
        }
    }

    public void Dispose() => Close();
}

/// <summary>
/// Distribui eventos para os fluxos SSE abertos. Reutilizável por qualquer módulo (um broadcaster por tipo de
/// dado). A instância é do contêiner, não estática; quem a registra decide o <see cref="SseStreamOptions"/>.
/// </summary>
public sealed partial class SseBroadcaster<T>(SseStreamOptions options)
{
    private readonly object _gate = new();
    private readonly List<SseSubscription<T>> _subscriptions = [];

    public int SubscriberCount
    {
        get
        {
            lock (_gate)
            {
                return _subscriptions.Count;
            }
        }
    }

    public SseStreamOptions Options { get; } = options ?? throw new ArgumentNullException(nameof(options));

    /// <summary>
    /// Abre um fluxo para <paramref name="owner"/>. Se ele já tem o máximo de fluxos, o mais antigo é fechado.
    /// O instantâneo entra na fila antes de qualquer evento novo: quem lê recebe primeiro o estado e depois as mudanças.
    /// </summary>
    public SseSubscription<T> Subscribe(string owner, Func<IEnumerable<SseMessage<T>>>? snapshot = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(owner);

        List<SseSubscription<T>> evicted = [];
        SseSubscription<T> subscription;
        lock (_gate)
        {
            var mine = _subscriptions.Where(s => string.Equals(s.Owner, owner, StringComparison.Ordinal)).ToList();
            var excess = mine.Count - (Options.MaxStreamsPerUser - 1);
            for (var i = 0; i < excess; i++)
            {
                // A lista guarda na ordem de abertura: o primeiro de "mine" é o mais antigo.
                evicted.Add(mine[i]);
            }

            subscription = new SseSubscription<T>(owner, Options.SubscriberQueue, Remove);
            if (snapshot is not null)
            {
                foreach (var item in snapshot())
                {
                    Validate(item);
                    subscription.TryEnqueue(item);
                }
            }

            _subscriptions.Add(subscription);
        }

        // Fechar fora do lock: Close() volta a pedir o lock para se remover.
        foreach (var old in evicted)
        {
            old.Close();
        }

        return subscription;
    }

    /// <summary>Entrega o evento a todos os fluxos abertos; quem está com a fila cheia é fechado.</summary>
    public void Publish(SseMessage<T> message)
    {
        ArgumentNullException.ThrowIfNull(message);
        Validate(message);

        SseSubscription<T>[] targets;
        lock (_gate)
        {
            targets = [.. _subscriptions];
        }

        foreach (var subscription in targets)
        {
            if (!subscription.TryEnqueue(message))
            {
                subscription.Close();
            }
        }
    }

    private void Remove(SseSubscription<T> subscription)
    {
        lock (_gate)
        {
            _subscriptions.Remove(subscription);
        }
    }

    // O nome do evento vai cru na linha "event:": quebra de linha nele injetaria campos no fluxo.
    private static void Validate(SseMessage<T> message)
    {
        if (!EventName().IsMatch(message.EventType))
        {
            throw new ArgumentException("Nome de evento SSE inválido.", nameof(message));
        }
    }

    [GeneratedRegex("^[A-Za-z0-9._-]{1,64}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex EventName();
}
