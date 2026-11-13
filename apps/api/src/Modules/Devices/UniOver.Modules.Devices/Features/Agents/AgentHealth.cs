using Microsoft.Extensions.Options;

namespace UniOver.Modules.Devices.Features.Agents;

/// <summary>Como a API enxerga a conexão viva de um agente, medida pelo que chega dele (nunca pelo banco).</summary>
internal enum AgentHealthState
{
    /// <summary>Responde como sempre (ou ainda não há o que medir).</summary>
    Ready,

    /// <summary>Respondeu tarde ou deixou um comando sem resposta, mas segue mandando sinal: os comandos continuam saindo.</summary>
    Slow,

    /// <summary>O socket segue aberto, mas o agente está mudo (PC paginado, laço parado): os comandos falham na hora.</summary>
    Unresponsive,
}

/// <summary>
/// A saúde de cada agente conectado, só em memória. Hoje a presença só diz se o socket está aberto: um PC com o laço parado
/// (paginado) segue verde por toda a graça de presença e cada comando espera o prazo inteiro (8 a 25 s) para falhar. Aqui
/// entram os sinais que já chegam pela conexão:
/// <list type="bullet">
/// <item>qualquer quadro do agente (o <c>agent.keepalive.v1</c> sai a cada
/// 5 s no agente de agora e 25 s no anterior, mesmo ocioso);</item>
/// <item>a resposta de cada comando e quanto ela levou, comparada ao prazo do próprio comando;</item>
/// <item>os prazos estourados, que só contam como "mudo" quando nem o batimento chegou.</item>
/// </list>
/// <para>
/// Os limites derivam do intervalo do batimento MEDIDO na sessão (<see cref="AgentConnections.LastKeepalive"/>), não de uma
/// constante: o agente de agora bate a cada 5 s e o anterior a cada 25 s, e os dois convivem. Ver <see cref="SilenceFor"/> e
/// <see cref="MuteAfterFor"/>: com 25 s, 35 s e 30 s (como sempre); com 5 s, os pisos de 15 s (3 batimentos perdidos) e 10 s.
/// O intervalo configurado (<see cref="DevicesTransportOptions.AgentKeepAliveSeconds"/>, 25 s, o mais folgado) vale até o
/// segundo batimento da sessão e é o teto do medido.
/// <see cref="AgentHealthState.Unresponsive"/> com o silêncio sem quadro nenhum, com ou sem uso; ou com
/// <see cref="DevicesTransportOptions.HealthStalledMisses"/> prazos estourados "mudos", cada um com o agente calado há ao menos
/// o limite de "mudo" e enviado depois do prazo mudo anterior (prazos que estouram juntos contam um só). Um prazo estourado
/// com o batimento em dia (a TV abrindo a sessão devagar) é só "lento": o comando seguinte continua saindo. Qualquer quadro tira do "mudo"; a resposta em
/// dia tira do "lento". Só vale para o agente que declarou
/// <c>transport.keepalive.v1</c>: sem o batimento, o silêncio de um agente ocioso não diria nada e, como o comando que falha
/// na hora não sai, nada o tiraria do "mudo".
/// </para>
/// <para>
/// Premissa: a API roda numa instância só (Render grátis, ver <c>SystemSettingsCache</c> no Identity), e é nela que a sessão
/// do agente vive; por isso o estado é da instância, como o <see cref="ReplyCorrelator"/>. Nada aqui lê ou grava o banco, e
/// o único temporizador é o do silêncio de cada agente, em memória: o Neon continua dormindo.
/// </para>
/// </summary>
internal sealed class AgentHealth : IDisposable
{
    private static readonly TimeSpan MinSilence = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan MinMuteAfter = TimeSpan.FromSeconds(10);
    private readonly TimeProvider _time;
    private readonly AgentConnections? _connections;
    private readonly TimeSpan _configuredBeat;
    private readonly int _stalledMisses;
    private readonly object _gate = new();
    private readonly Dictionary<string, Entry> _agents = new(StringComparer.Ordinal);

    public AgentHealth(TimeProvider time, IOptions<DevicesTransportOptions> options, AgentConnections? connections = null)
    {
        ArgumentNullException.ThrowIfNull(time);
        ArgumentNullException.ThrowIfNull(options);
        _time = time;
        _connections = connections;
        _configuredBeat = TimeSpan.FromSeconds(options.Value.AgentKeepAliveSeconds);
        _stalledMisses = options.Value.HealthStalledMisses;
    }

    /// <summary>A saúde de agora; <see cref="AgentHealthState.Ready"/> para quem não é medido.</summary>
    public AgentHealthState Of(string agentId)
    {
        lock (_gate)
        {
            return _agents.TryGetValue(agentId, out var entry) ? entry.State(_stalledMisses) : AgentHealthState.Ready;
        }
    }

    /// <summary>A saúde que vai à tela: nula para quem não é medido (agente antigo, ou o <c>hello</c> ainda não chegou).</summary>
    public string? Describe(string agentId)
    {
        lock (_gate)
        {
            return _agents.TryGetValue(agentId, out var entry) && entry.Watched ? Text(entry.State(_stalledMisses)) : null;
        }
    }

    public bool IsUnresponsive(string agentId) => Of(agentId) == AgentHealthState.Unresponsive;

    /// <summary>Sessão nova (inclusive a passagem de versão): a medição recomeça do zero e só volta com o <c>hello</c>.</summary>
    public void Reset(string agentId) => Change(agentId, entry =>
    {
        entry.Stop();
        entry.Watched = false;
        entry.Clear();
    });

    /// <summary>
    /// O <c>hello</c> da sessão atual chegou: com o batimento declarado, passa a medir; sem ele, fica de fora (como hoje).
    /// </summary>
    public void Watch(string agentId, bool declaresKeepAlive) => Change(agentId, entry =>
    {
        if (!declaresKeepAlive)
        {
            entry.Stop();
            entry.Watched = false;
            entry.Clear();
            return;
        }

        if (!entry.Watched)
        {
            entry.Watched = true;
            entry.Clear();
        }

        Seen(agentId, entry);
    });

    /// <summary>Chegou um quadro da sessão atual: o agente está vivo agora.</summary>
    public void OnFrame(string agentId) => Change(agentId, entry =>
    {
        if (entry.Watched)
        {
            entry.SilentMisses = 0;
            Seen(agentId, entry);
        }
    }, create: false);

    /// <summary>A resposta de um comando chegou depois de <paramref name="latency"/>; tarde é mais da metade do prazo dele.</summary>
    public void OnReply(string agentId, TimeSpan latency, TimeSpan timeout) => Change(agentId, entry =>
    {
        if (entry.Watched)
        {
            entry.SilentMisses = 0;
            entry.Slow = latency > timeout / 2;
        }
    }, create: false);

    /// <summary>Um comando enviado em <paramref name="sentAt"/> ficou sem resposta no prazo.</summary>
    public void OnTimeout(string agentId, DateTimeOffset sentAt) => Change(agentId, entry =>
    {
        if (!entry.Watched)
        {
            return;
        }

        entry.Slow = true;
        var now = _time.GetUtcNow();
        if (entry.LastFrameAt > sentAt || now - entry.LastFrameAt < MuteAfterFor(BeatOf(agentId, entry)))
        {
            // Chegou algo depois do envio, ou o batimento ainda está em dia: o laço está vivo, o comando só demorou.
            entry.SilentMisses = 0;
            return;
        }

        // Prazos que estouram juntos (vários toques no mesmo instante) são um só sinal: conta o que foi enviado depois do anterior.
        if (sentAt >= entry.LastMuteMissAt)
        {
            entry.SilentMisses++;
            entry.LastMuteMissAt = now;
        }
    }, create: false);

    /// <summary>A sessão saiu: não há o que medir até a próxima.</summary>
    public void Forget(string agentId)
    {
        lock (_gate)
        {
            if (_agents.Remove(agentId, out var entry))
            {
                entry.Stop();
            }
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (var entry in _agents.Values)
            {
                entry.Stop();
            }

            _agents.Clear();
        }
    }

    internal static string Text(AgentHealthState state) => state switch
    {
        AgentHealthState.Slow => "slow",
        AgentHealthState.Unresponsive => "unresponsive",
        _ => "ready",
    };

    /// <summary>
    /// Sem nenhum quadro por isto, o agente está "sem resposta": 1,4 batimento, com o piso de 15 s. Com o de 25 s, 35 s (como
    /// sempre); com o de 5 s, o piso: 3 batimentos perdidos (um batimento curto atrasado pela rede não é PC parado).
    /// </summary>
    internal static TimeSpan SilenceFor(TimeSpan beat) => Max(MinSilence, beat * 1.4);

    /// <summary>
    /// Um prazo estourado só conta como "mudo" com o agente calado há isto: 1,2 batimento, com o piso de 10 s (2 batimentos de
    /// 5 s). Com o de 25 s, 30 s (como sempre). Sempre abaixo de <see cref="SilenceFor"/>.
    /// </summary>
    internal static TimeSpan MuteAfterFor(TimeSpan beat) => Max(MinMuteAfter, beat * 1.2);

    private static TimeSpan Max(TimeSpan a, TimeSpan b) => a > b ? a : b;

    /// <summary>
    /// O intervalo do batimento medido nesta sessão: o maior dos dois últimos (um par de batimentos colados, depois de um
    /// atrasado pela rede, não aperta os limites), nunca acima do configurado (a volta de um PC paginado mede a pausa
    /// inteira, e ela não afrouxa os limites além dos de sempre). Sem medida ainda, o configurado. Quem chama segura o lock.
    /// </summary>
    private TimeSpan BeatOf(string agentId, Entry entry)
    {
        if (_connections?.LastKeepalive(agentId) is { Interval: { } interval } sample
            && sample.ReceivedAt != entry.LastBeatAt
            && interval > TimeSpan.Zero)
        {
            entry.LastBeatAt = sample.ReceivedAt;
            entry.PreviousInterval = entry.LastInterval;
            entry.LastInterval = interval;
        }

        var measured = Max(entry.LastInterval ?? TimeSpan.Zero, entry.PreviousInterval ?? TimeSpan.Zero);
        return measured > TimeSpan.Zero && measured < _configuredBeat ? measured : _configuredBeat;
    }

    /// <summary>Quem chama segura o lock: anota o quadro e rearma o temporizador do silêncio pelo batimento desta sessão.</summary>
    private void Seen(string agentId, Entry entry)
    {
        entry.LastFrameAt = _time.GetUtcNow();
        entry.Silent = false;
        entry.SilenceAfter = SilenceFor(BeatOf(agentId, entry));
        if (entry.Timer is null)
        {
            entry.Timer = _time.CreateTimer(_ => OnSilence(agentId, entry), null, entry.SilenceAfter, Timeout.InfiniteTimeSpan);
        }
        else
        {
            entry.Timer.Change(entry.SilenceAfter, Timeout.InfiniteTimeSpan);
        }
    }

    private void OnSilence(string agentId, Entry fired) => Change(agentId, entry =>
    {
        // Um temporizador de uma sessão anterior (já trocada) não vale para a de agora.
        if (ReferenceEquals(entry, fired) && entry.Watched && _time.GetUtcNow() - entry.LastFrameAt >= entry.SilenceAfter)
        {
            entry.Silent = true;
        }
    }, create: false);

    /// <summary>
    /// Aplica a mudança sob o lock e, se a saúde visível mudou, avisa o SSE ainda sob ele: assim dois avisos nunca saem fora de
    /// ordem. Não há ciclo de travas: <see cref="AgentConnections"/> nunca chama de volta esta classe, e o aviso só enfileira.
    /// </summary>
    /// <param name="create">Só a sessão nova (<see cref="Reset"/>) e o <c>hello</c> criam a medição; o resto só mexe na que existe.</param>
    private void Change(string agentId, Action<Entry> apply, bool create = true)
    {
        lock (_gate)
        {
            if (!_agents.TryGetValue(agentId, out var entry))
            {
                if (!create)
                {
                    return;
                }

                entry = new Entry();
                _agents[agentId] = entry;
            }

            apply(entry);
            var now = entry.Watched ? entry.State(_stalledMisses) : AgentHealthState.Ready;
            if (now != entry.Announced)
            {
                entry.Announced = now;
                _connections?.AnnounceHealth(agentId, Text(now));
            }
        }
    }

    private sealed class Entry
    {
        public bool Watched { get; set; }

        public DateTimeOffset LastFrameAt { get; set; }

        /// <summary>O silêncio que vale desde o último quadro (do batimento medido quando ele chegou).</summary>
        public TimeSpan SilenceAfter { get; set; }

        /// <summary>Quando chegou o último batimento já contado e os dois últimos intervalos medidos (nulos sem medida).</summary>
        public DateTimeOffset LastBeatAt { get; set; }

        public TimeSpan? LastInterval { get; set; }

        public TimeSpan? PreviousInterval { get; set; }

        public int SilentMisses { get; set; }

        public DateTimeOffset LastMuteMissAt { get; set; }

        public bool Slow { get; set; }

        public bool Silent { get; set; }

        public AgentHealthState Announced { get; set; }

        public ITimer? Timer { get; set; }

        public AgentHealthState State(int stalledMisses) =>
            !Watched ? AgentHealthState.Ready
            : Silent || SilentMisses >= stalledMisses ? AgentHealthState.Unresponsive
            : Slow ? AgentHealthState.Slow
            : AgentHealthState.Ready;

        public void Clear()
        {
            LastBeatAt = default;
            LastInterval = null;
            PreviousInterval = null;
            SilentMisses = 0;
            LastMuteMissAt = DateTimeOffset.MinValue;
            Slow = false;
            Silent = false;
        }

        public void Stop()
        {
            Timer?.Dispose();
            Timer = null;
        }
    }
}
