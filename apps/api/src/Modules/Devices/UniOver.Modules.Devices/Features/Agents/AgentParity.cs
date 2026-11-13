using UniOver.BuildingBlocks.AgentProtocol.Generated;

namespace UniOver.Modules.Devices.Features.Agents;

/// <summary>
/// Os quatro números da paridade com o Unified Remote, por computador, nos últimos <see cref="Window"/>. Só fica o que é preciso
/// para a conta; nada sobrevive a um reinício da API.
/// </summary>
/// <param name="AgentId">O identificador (slug) do agente.</param>
/// <param name="DirectSeconds">Segundos com tecla ou mouse pelo canal direto, como o app contou.</param>
/// <param name="CloudSeconds">Segundos com tecla ou mouse pela nuvem, contados aqui na entrega ao agente.</param>
/// <param name="DirectPercent">A parte do tempo de uso que foi direta, de 0 a 100; nula sem uso na janela.</param>
/// <param name="ReplySamples">Comandos de entrada pela nuvem que tiveram resposta na janela.</param>
/// <param name="ReplyP50Ms">Do envio na API à resposta do agente (já executado), mediana; nula com poucas amostras.</param>
/// <param name="ReplyP95Ms">O mesmo, percentil 95.</param>
/// <param name="LoopLagSamples">Batimentos com o atraso do laço do agente na janela (zero com o agente que ainda não o manda).</param>
/// <param name="LoopLagP99Ms">Percentil 99 do maior atraso do laço por batimento; nulo sem amostras suficientes.</param>
/// <param name="Unanswered">Comandos que ficaram sem resposta no prazo, na janela.</param>
internal sealed record AgentParitySnapshot(
    string AgentId,
    int DirectSeconds,
    int CloudSeconds,
    int? DirectPercent,
    int ReplySamples,
    int? ReplyP50Ms,
    int? ReplyP95Ms,
    int LoopLagSamples,
    int? LoopLagP99Ms,
    int Unanswered);

/// <summary>
/// A paridade com o Unified Remote, medida só em memória (o banco precisa dormir). Cada série é uma fila por agente, com a
/// janela de <see cref="Window"/> e um teto de <see cref="MaxSamples"/> amostras: a conta é sempre pequena, o tráfego que
/// for. As fontes:
/// <list type="bullet">
/// <item><b>Canal direto x nuvem:</b> em segundos de uso, não em mensagens (o ponteiro direto sai a cada 10 ms e o da nuvem a
/// cada 32 ms; contar mensagens puxaria para o direto). A nuvem é contada aqui, na entrega de cada comando de entrada ao agente
/// (um por segundo); o direto não passa pela API, então o app conta os segundos dele e os manda de tempos em tempos.</item>
/// <item><b>Resposta do comando:</b> do envio na API à resposta do agente, no relógio monotônico da API (o relógio do PC não
/// entra). Inclui a volta da resposta: é a ida e volta, não só a ida. Só comandos de entrada pela nuvem.</item>
/// <item><b>Atraso do laço:</b> o maior atraso por batimento que o agente manda em <c>loopLagMs</c>; sem ele, nada.</item>
/// <item><b>Sem resposta:</b> cada prazo estourado de um pedido ao agente.</item>
/// </list>
/// Premissa igual à de <see cref="AgentHealth"/>: uma instância só. Reconectar não zera nada (a janela é de 30 min).
/// </summary>
internal sealed class AgentParity(TimeProvider time)
{
    /// <summary>A janela dos números.</summary>
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(30);

    /// <summary>Teto de amostras por série e agente (30 min de batimento a cada 5 s são 360; de uso contínuo, 1.800 segundos).</summary>
    public const int MaxSamples = 2_048;

    /// <summary>Abaixo disto um percentil não diz nada: a tela mostra "—".</summary>
    public const int MinPercentileSamples = 5;

    /// <summary>Teto de segundos diretos num relatório do app (ele manda a cada minuto; a folga cobre um atraso do envio).</summary>
    public const int MaxDirectSecondsPerReport = 600;

    /// <summary>Teto de agentes acompanhados (só os que têm sessão viva entram; isto é só a defesa).</summary>
    public const int MaxAgents = 64;

    private readonly object _gate = new();
    private readonly Dictionary<string, Entry> _agents = new(StringComparer.Ordinal);

    /// <summary>Os comandos de entrada: tecla, mouse, texto e mídia do PC, e tecla e texto da TV.</summary>
    public static bool IsInput(string type) =>
        type.StartsWith("pc.pointer.", StringComparison.Ordinal)
        || type.StartsWith("pc.click.", StringComparison.Ordinal)
        || type.StartsWith("pc.key.", StringComparison.Ordinal)
        || type.StartsWith("pc.text.", StringComparison.Ordinal)
        || type.StartsWith("pc.media.", StringComparison.Ordinal)
        || string.Equals(type, AgentMessageTypes.PcVolumeV1, StringComparison.Ordinal)
        || type.StartsWith("tv.key.", StringComparison.Ordinal)
        || type.StartsWith("tv.text.", StringComparison.Ordinal);

    /// <summary>Um comando de entrada saiu pela nuvem para o agente: conta o segundo de agora (uma vez por segundo).</summary>
    public void OnCloudInput(string agentId) => With(agentId, (entry, now) =>
    {
        var second = now.ToUnixTimeSeconds();
        if (second != entry.LastCloudSecond)
        {
            entry.LastCloudSecond = second;
            entry.Cloud.Add(now, 1);
        }
    });

    /// <summary>O app contou <paramref name="seconds"/> segundos com entrada pelo canal direto desde o último relatório.</summary>
    public void OnDirectUse(string agentId, int seconds)
    {
        if (seconds <= 0)
        {
            return;
        }

        With(agentId, (entry, now) => entry.Direct.Add(now, Math.Min(seconds, MaxDirectSecondsPerReport)));
    }

    /// <summary>Um comando de entrada pela nuvem teve resposta depois de <paramref name="latency"/>.</summary>
    public void OnReply(string agentId, TimeSpan latency) =>
        With(agentId, (entry, now) => entry.Replies.Add(now, (int)Math.Clamp(Math.Round(latency.TotalMilliseconds), 0, int.MaxValue)));

    /// <summary>Um pedido ao agente ficou sem resposta no prazo.</summary>
    public void OnUnanswered(string agentId) => With(agentId, (entry, now) => entry.Unanswered.Add(now, 1));

    /// <summary>O batimento trouxe o maior atraso do laço desde o anterior.</summary>
    public void OnLoopLag(string agentId, int milliseconds)
    {
        if (milliseconds >= 0)
        {
            With(agentId, (entry, now) => entry.LoopLag.Add(now, milliseconds));
        }
    }

    /// <summary>Os números de agora de cada agente com alguma amostra na janela.</summary>
    public IReadOnlyList<AgentParitySnapshot> Snapshot()
    {
        var floor = time.GetUtcNow() - Window;
        lock (_gate)
        {
            var list = new List<AgentParitySnapshot>(_agents.Count);
            foreach (var (agentId, entry) in _agents.ToList())
            {
                entry.Prune(floor);
                if (entry.IsEmpty)
                {
                    _agents.Remove(agentId);
                    continue;
                }

                list.Add(entry.Describe(agentId));
            }

            list.Sort((a, b) => string.CompareOrdinal(a.AgentId, b.AgentId));
            return list;
        }
    }

    /// <summary>Os números de um agente (zerados quando não há nada na janela).</summary>
    public AgentParitySnapshot Of(string agentId)
    {
        var floor = time.GetUtcNow() - Window;
        lock (_gate)
        {
            if (!_agents.TryGetValue(agentId, out var entry))
            {
                return new Entry().Describe(agentId);
            }

            entry.Prune(floor);
            return entry.Describe(agentId);
        }
    }

    /// <summary>Percentil pelo posto mais próximo (o valor de uma amostra real, nunca interpolado); nulo com poucas amostras.</summary>
    internal static int? Percentile(IReadOnlyList<int> values, double percentile)
    {
        if (values.Count < MinPercentileSamples)
        {
            return null;
        }

        var sorted = values.Order().ToArray();
        var rank = (int)Math.Ceiling(percentile / 100.0 * sorted.Length);
        return sorted[Math.Clamp(rank, 1, sorted.Length) - 1];
    }

    private void With(string agentId, Action<Entry, DateTimeOffset> apply)
    {
        if (string.IsNullOrEmpty(agentId))
        {
            return;
        }

        var now = time.GetUtcNow();
        lock (_gate)
        {
            if (!_agents.TryGetValue(agentId, out var entry))
            {
                if (_agents.Count >= MaxAgents)
                {
                    EvictIdle(now - Window);
                    if (_agents.Count >= MaxAgents)
                    {
                        return;
                    }
                }

                entry = new Entry();
                _agents[agentId] = entry;
            }

            entry.Prune(now - Window);
            apply(entry, now);
        }
    }

    private void EvictIdle(DateTimeOffset floor)
    {
        foreach (var (agentId, entry) in _agents.ToList())
        {
            entry.Prune(floor);
            if (entry.IsEmpty)
            {
                _agents.Remove(agentId);
            }
        }
    }

    /// <summary>Uma série com janela e teto: as amostras mais velhas saem primeiro.</summary>
    private sealed class Series
    {
        private readonly Queue<(DateTimeOffset At, int Value)> _samples = new();

        public int Count => _samples.Count;

        public void Add(DateTimeOffset at, int value)
        {
            _samples.Enqueue((at, value));
            while (_samples.Count > MaxSamples)
            {
                _samples.Dequeue();
            }
        }

        public void Prune(DateTimeOffset floor)
        {
            while (_samples.Count > 0 && _samples.Peek().At <= floor)
            {
                _samples.Dequeue();
            }
        }

        public int Sum() => _samples.Sum(s => s.Value);

        public IReadOnlyList<int> Values() => [.. _samples.Select(s => s.Value)];
    }

    private sealed class Entry
    {
        public Series Direct { get; } = new();

        public Series Cloud { get; } = new();

        public Series Replies { get; } = new();

        public Series LoopLag { get; } = new();

        public Series Unanswered { get; } = new();

        public long LastCloudSecond { get; set; } = long.MinValue;

        public bool IsEmpty =>
            Direct.Count == 0 && Cloud.Count == 0 && Replies.Count == 0 && LoopLag.Count == 0 && Unanswered.Count == 0;

        public void Prune(DateTimeOffset floor)
        {
            Direct.Prune(floor);
            Cloud.Prune(floor);
            Replies.Prune(floor);
            LoopLag.Prune(floor);
            Unanswered.Prune(floor);
        }

        public AgentParitySnapshot Describe(string agentId)
        {
            var direct = Direct.Sum();
            var cloud = Cloud.Sum();
            var total = direct + cloud;
            var replies = Replies.Values();
            var lags = LoopLag.Values();
            return new AgentParitySnapshot(
                agentId,
                direct,
                cloud,
                total == 0 ? null : (int)Math.Round(100.0 * direct / total),
                replies.Count,
                Percentile(replies, 50),
                Percentile(replies, 95),
                lags.Count,
                Percentile(lags, 99),
                Unanswered.Sum());
        }
    }
}
