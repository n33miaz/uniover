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
/// <see cref="DevicesTransportOptions.AgentKeepAliveSeconds"/>, 25 s hoje, mesmo ocioso);</item>
/// <item>a resposta de cada comando e quanto ela levou, comparada ao prazo do próprio comando;</item>
/// <item>os prazos estourados, que só contam como "mudo" quando nem o batimento chegou.</item>
/// </list>
/// <para>
/// Os limites derivam do intervalo do batimento, para valerem com o de 25 s de hoje e com um mais curto depois:
/// <see cref="AgentHealthState.Unresponsive"/> com <see cref="DevicesTransportOptions.HealthSilence"/> (1,4 batimento: 35 s) sem
/// quadro nenhum, com ou sem uso; ou com <see cref="DevicesTransportOptions.HealthStalledMisses"/> prazos estourados "mudos",
/// cada um com o agente calado há ao menos <see cref="DevicesTransportOptions.HealthMuteAfter"/> (1,2 batimento: 30 s) e enviado
/// depois do prazo mudo anterior (prazos que estouram juntos contam um só). Um prazo estourado com o batimento em dia (a TV
/// abrindo a sessão devagar) é só "lento": o comando seguinte continua saindo. Qualquer quadro tira do "mudo"; a resposta em
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
    private readonly TimeProvider _time;
    private readonly AgentConnections? _connections;
    private readonly TimeSpan _silence;
    private readonly TimeSpan _muteAfter;
    private readonly int _stalledMisses;
    private readonly object _gate = new();
    private readonly Dictionary<string, Entry> _agents = new(StringComparer.Ordinal);

    public AgentHealth(TimeProvider time, IOptions<DevicesTransportOptions> options, AgentConnections? connections = null)
    {
        ArgumentNullException.ThrowIfNull(time);
        ArgumentNullException.ThrowIfNull(options);
        _time = time;
        _connections = connections;
        _silence = options.Value.HealthSilence;
        _muteAfter = options.Value.HealthMuteAfter;
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
        if (entry.LastFrameAt > sentAt || now - entry.LastFrameAt < _muteAfter)
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

    /// <summary>Quem chama segura o lock: anota o quadro e rearma o temporizador do silêncio.</summary>
    private void Seen(string agentId, Entry entry)
    {
        entry.LastFrameAt = _time.GetUtcNow();
        entry.Silent = false;
        if (entry.Timer is null)
        {
            entry.Timer = _time.CreateTimer(_ => OnSilence(agentId, entry), null, _silence, Timeout.InfiniteTimeSpan);
        }
        else
        {
            entry.Timer.Change(_silence, Timeout.InfiniteTimeSpan);
        }
    }

    private void OnSilence(string agentId, Entry fired) => Change(agentId, entry =>
    {
        // Um temporizador de uma sessão anterior (já trocada) não vale para a de agora.
        if (ReferenceEquals(entry, fired) && entry.Watched && _time.GetUtcNow() - entry.LastFrameAt >= _silence)
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
