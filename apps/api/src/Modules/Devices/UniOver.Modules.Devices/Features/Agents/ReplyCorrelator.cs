using System.Collections.Concurrent;
using Microsoft.Extensions.Options;
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

    /// <summary>O agente desconectou de vez: quem esperava resposta dele falha na hora em vez de esperar o tempo todo.</summary>
    void FailAll(string agentId);

    /// <summary>
    /// A conexão do agente caiu, mas ele costuma voltar em segundos (troca de instância na publicação, rede): quem esperava resposta
    /// continua esperando por um prazo curto (<see cref="DevicesTransportOptions.ReplyHold"/>). Se o agente voltar
    /// (<see cref="Release"/>), o resultado ainda chega por <c>commandId</c>; se não, a espera falha como em <see cref="FailAll"/>.
    /// </summary>
    void Hold(string agentId);

    /// <summary>O agente voltou: as esperas seguradas por <see cref="Hold"/> seguem o prazo normal de cada comando.</summary>
    void Release(string agentId);

    /// <summary>Espera, até <paramref name="timeout"/>, não haver mais nenhum comando esperando resposta. Devolve se esvaziou.</summary>
    Task<bool> WaitForIdleAsync(TimeSpan timeout, CancellationToken cancellationToken);
}

internal sealed class ReplyCorrelator(TimeProvider? time = null, IOptions<DevicesTransportOptions>? options = null) : IReplyCorrelator
{
    private static readonly TimeSpan IdlePoll = TimeSpan.FromMilliseconds(50);

    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly TimeSpan _hold = options?.Value.ReplyHold ?? TimeSpan.Zero;
    private readonly ConcurrentDictionary<Guid, Pending> _pending = new();
    private readonly object _gate = new();
    private readonly Dictionary<string, ITimer> _holds = new(StringComparer.Ordinal);

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
        CancelHold(agentId);
        foreach (var (id, pending) in _pending)
        {
            if (string.Equals(pending.AgentId, agentId, StringComparison.Ordinal) && _pending.TryRemove(id, out _))
            {
                pending.Completion.TrySetException(new AgentDisconnectedException());
            }
        }
    }

    public void Hold(string agentId)
    {
        if (_hold <= TimeSpan.Zero)
        {
            FailAll(agentId);
            return;
        }

        var held = false;
        foreach (var pending in _pending.Values)
        {
            if (string.Equals(pending.AgentId, agentId, StringComparison.Ordinal))
            {
                pending.Held = true;
                held = true;
            }
        }

        if (!held)
        {
            return;
        }

        lock (_gate)
        {
            if (_holds.Remove(agentId, out var previous))
            {
                previous.Dispose();
            }

            _holds[agentId] = _time.CreateTimer(_ => ExpireHold(agentId), null, _hold, Timeout.InfiniteTimeSpan);
        }
    }

    public void Release(string agentId)
    {
        CancelHold(agentId);
        foreach (var pending in _pending.Values)
        {
            if (string.Equals(pending.AgentId, agentId, StringComparison.Ordinal))
            {
                pending.Held = false;
            }
        }
    }

    public async Task<bool> WaitForIdleAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        var deadline = _time.GetUtcNow() + timeout;
        while (!_pending.IsEmpty)
        {
            var left = deadline - _time.GetUtcNow();
            if (left <= TimeSpan.Zero)
            {
                return false;
            }

            await Task.Delay(left < IdlePoll ? left : IdlePoll, _time, cancellationToken);
        }

        return true;
    }

    private void CancelHold(string agentId)
    {
        lock (_gate)
        {
            if (_holds.Remove(agentId, out var timer))
            {
                timer.Dispose();
            }
        }
    }

    /// <summary>O prazo acabou sem o agente voltar: só falham as esperas que continuam seguradas (as de comandos novos têm prazo próprio).</summary>
    private void ExpireHold(string agentId)
    {
        CancelHold(agentId);
        foreach (var (id, pending) in _pending)
        {
            if (pending.Held
                && string.Equals(pending.AgentId, agentId, StringComparison.Ordinal)
                && _pending.TryRemove(id, out _))
            {
                pending.Completion.TrySetException(new AgentDisconnectedException());
            }
        }
    }

    private sealed class Pending(ReplyCorrelator owner, string agentId, Guid commandId) : IPendingReply
    {
        public string AgentId { get; } = agentId;

        /// <summary>A conexão caiu depois do envio e a espera aguarda a volta do agente (ver <see cref="IReplyCorrelator.Hold"/>).</summary>
        public volatile bool Held;

        public TaskCompletionSource<AgentReply> Completion { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task<AgentReply> Reply => Completion.Task;

        public void Dispose() => owner._pending.TryRemove(commandId, out _);
    }
}
