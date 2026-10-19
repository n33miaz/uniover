using System.Collections.Concurrent;
using UniOver.Modules.Devices.Contracts.Agents;

namespace UniOver.Modules.Devices.Features.Agents;

/// <summary>A conexão com o agente caiu enquanto se esperava a resposta dele.</summary>
internal sealed class AgentDisconnectedException : Exception
{
    public AgentDisconnectedException()
        : base("O agente desconectou antes de responder.")
    {
    }
}

/// <summary>Um comando esperando resposta; descartar (<c>Dispose</c>) tira a espera do dicionário.</summary>
internal interface IPendingReply : IDisposable
{
    Task<AgentReply> Reply { get; }
}

/// <summary>
/// Liga cada <c>command.result.v1</c> ao comando que o originou, pelo <c>id</c> do comando (o <c>correlationId</c> da
/// resposta aponta o comando). O dicionário é da instância, atrás desta interface, nunca estático.
/// </summary>
internal interface IReplyCorrelator
{
    /// <summary>Registra a espera <b>antes</b> de enviar o comando: assim uma resposta rápida não se perde.</summary>
    IPendingReply Expect(string agentId, Guid commandId);

    /// <summary>
    /// Entrega a resposta a quem espera. Falso quando ninguém espera (resposta tardia, repetida ou de outro agente):
    /// quem chama registra e descarta.
    /// </summary>
    bool TryComplete(string agentId, Guid commandId, AgentReply reply);

    /// <summary>O agente desconectou: quem esperava resposta dele falha na hora em vez de esperar o tempo todo.</summary>
    void FailAll(string agentId);
}

internal sealed class ReplyCorrelator : IReplyCorrelator
{
    private readonly ConcurrentDictionary<Guid, Pending> _pending = new();

    public IPendingReply Expect(string agentId, Guid commandId)
    {
        var pending = new Pending(this, agentId, commandId);
        if (!_pending.TryAdd(commandId, pending))
        {
            throw new InvalidOperationException("Já existe uma espera para este comando.");
        }

        return pending;
    }

    public bool TryComplete(string agentId, Guid commandId, AgentReply reply)
    {
        // A resposta só vale vinda do agente que recebeu o comando: um agente não completa o comando de outro.
        if (_pending.TryGetValue(commandId, out var pending)
            && string.Equals(pending.AgentId, agentId, StringComparison.Ordinal)
            && _pending.TryRemove(commandId, out _))
        {
            return pending.Completion.TrySetResult(reply);
        }

        return false;
    }

    public void FailAll(string agentId)
    {
        foreach (var (id, pending) in _pending)
        {
            if (string.Equals(pending.AgentId, agentId, StringComparison.Ordinal) && _pending.TryRemove(id, out _))
            {
                pending.Completion.TrySetException(new AgentDisconnectedException());
            }
        }
    }

    private sealed class Pending(ReplyCorrelator owner, string agentId, Guid commandId) : IPendingReply
    {
        public string AgentId { get; } = agentId;

        public TaskCompletionSource<AgentReply> Completion { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task<AgentReply> Reply => Completion.Task;

        public void Dispose() => owner._pending.TryRemove(commandId, out _);
    }
}
