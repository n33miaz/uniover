using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Features.RemoteCare;

/// <summary>O fim do registro de um agente, já higienizado por ele (nada aqui é gravado em banco nem em log).</summary>
internal sealed record AgentLogReport(string Text, int Lines, bool Truncated, DateTimeOffset At);

/// <summary>Um pedido de registro em andamento; descartar (<c>Dispose</c>) libera a vez do agente.</summary>
internal interface IAgentLogTicket : IDisposable
{
    Guid RequestId { get; }

    /// <summary>O relatório, ou nulo se não veio no prazo. Pode já estar guardado: o agente o manda antes do resultado do comando.</summary>
    Task<AgentLogReport?> WaitAsync(TimeSpan grace, CancellationToken cancellationToken);
}

/// <summary>
/// Junta o <c>agent.logs.v1</c> ao pedido que o espera, pelo <c>requestId</c> e <b>pelo agente</b>: o relatório de outro
/// agente com o mesmo <c>requestId</c> não vale. Um pedido por agente por vez (o registro é pesado e o dono não precisa
/// de dois ao mesmo tempo). É da instância (singleton), nunca estático, e some quando a API reinicia.
/// </summary>
internal interface IAgentLogReports
{
    /// <summary>Abre a espera, ou nulo se este agente já tem um pedido em andamento.</summary>
    IAgentLogTicket? TryBegin(string agentSlug);

    /// <summary>Entrega o relatório a quem espera. Falso quando ninguém espera por ele (tardio, repetido, de outro agente).</summary>
    bool Complete(string agentSlug, Guid requestId, AgentLogReport report);
}

internal sealed class InMemoryAgentLogReports(TimeProvider time) : IAgentLogReports
{
    private readonly object _gate = new();
    private readonly Dictionary<string, Active> _active = new(StringComparer.Ordinal);

    public IAgentLogTicket? TryBegin(string agentSlug)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(agentSlug);

        lock (_gate)
        {
            if (_active.ContainsKey(agentSlug))
            {
                return null;
            }

            var active = new Active(IdGenerator.NewId());
            _active.Add(agentSlug, active);
            return new Ticket(this, agentSlug, active, time);
        }
    }

    public bool Complete(string agentSlug, Guid requestId, AgentLogReport report)
    {
        ArgumentNullException.ThrowIfNull(report);

        lock (_gate)
        {
            return _active.TryGetValue(agentSlug, out var active)
                && active.RequestId == requestId
                && active.Completion.TrySetResult(report);
        }
    }

    private void Release(string agentSlug, Active active)
    {
        lock (_gate)
        {
            if (_active.TryGetValue(agentSlug, out var current) && ReferenceEquals(current, active))
            {
                _active.Remove(agentSlug);
            }
        }
    }

    private sealed class Active(Guid requestId)
    {
        public Guid RequestId { get; } = requestId;

        public TaskCompletionSource<AgentLogReport> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private sealed class Ticket(InMemoryAgentLogReports owner, string agentSlug, Active active, TimeProvider time) : IAgentLogTicket
    {
        public Guid RequestId => active.RequestId;

        public async Task<AgentLogReport?> WaitAsync(TimeSpan grace, CancellationToken cancellationToken)
        {
            if (active.Completion.Task.IsCompletedSuccessfully)
            {
                return active.Completion.Task.Result;
            }

            try
            {
                return await active.Completion.Task.WaitAsync(grace, time, cancellationToken);
            }
            catch (TimeoutException)
            {
                return null;
            }
        }

        public void Dispose() => owner.Release(agentSlug, active);
    }
}
