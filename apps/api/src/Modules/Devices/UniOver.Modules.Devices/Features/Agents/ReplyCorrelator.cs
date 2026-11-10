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

    /// <summary>
    /// Marca, de forma atômica, que o comando vai sair pela <paramref name="session"/>. Falso quando a espera já falhou: quem
    /// chama NÃO envia (um comando nunca sai depois de a API já ter respondido falha). A sessão marcada é a que o hold da queda
    /// (<see cref="IReplyCorrelator.Hold"/>) reconhece como dona do comando.
    /// </summary>
    bool TryBeginSend(object session);
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

    /// <summary>
    /// O agente desconectou de vez: quem esperava resposta dele (enviada ou ainda esperando sessão) falha na hora em vez de
    /// esperar o tempo todo, e o que ainda não saiu não sai mais.
    /// </summary>
    void FailAll(string agentId);

    /// <summary>
    /// A conexão <paramref name="session"/> do agente caiu, mas ele costuma voltar em segundos (troca de instância na
    /// publicação, rede): os comandos enviados POR ELA continuam esperando por um prazo curto
    /// (<see cref="DevicesTransportOptions.ReplyHold"/>). Se o agente voltar (<see cref="Release"/>), o resultado ainda chega por
    /// <c>commandId</c>; se não, a espera falha como em <see cref="FailAll"/>. Comando que ainda não saiu (esperando uma sessão
    /// para ser entregue) não é tocado: segue o prazo da entrega, e quem o criou depois da queda nunca entra no hold.
    /// </summary>
    void Hold(string agentId, object session);

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
            && pending.TryComplete(reply))
        {
            _pending.TryRemove(commandId, out _);
            return true;
        }

        return false;
    }

    public void FailAll(string agentId)
    {
        CancelHold(agentId);
        foreach (var (id, pending) in _pending)
        {
            // A transição para "falhou" acontece sob o lock da espera, ANTES de ela sair do dicionário: daí em diante
            // TryBeginSend recusa e TryComplete não entrega, sem janela em que o comando ainda possa sair.
            if (string.Equals(pending.AgentId, agentId, StringComparison.Ordinal) && pending.TryFail())
            {
                _pending.TryRemove(id, out _);
            }
        }
    }

    public void Hold(string agentId, object session)
    {
        ArgumentNullException.ThrowIfNull(session);
        if (_hold <= TimeSpan.Zero)
        {
            FailSentBy(agentId, session);
            return;
        }

        var held = false;
        foreach (var pending in _pending.Values)
        {
            if (string.Equals(pending.AgentId, agentId, StringComparison.Ordinal) && pending.TryHold(session))
            {
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
                pending.Release();
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

    /// <summary>Sem prazo de volta: falha na hora só o que saiu pela <paramref name="session"/> que caiu.</summary>
    private void FailSentBy(string agentId, object session)
    {
        foreach (var (id, pending) in _pending)
        {
            if (string.Equals(pending.AgentId, agentId, StringComparison.Ordinal) && pending.TryFailIfSentOn(session))
            {
                _pending.TryRemove(id, out _);
            }
        }
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
            if (string.Equals(pending.AgentId, agentId, StringComparison.Ordinal) && pending.TryFailIfHeld())
            {
                _pending.TryRemove(id, out _);
            }
        }
    }

    private sealed class Pending(ReplyCorrelator owner, string agentId, Guid commandId) : IPendingReply
    {
        private readonly object _gate = new();
        private object? _session;
        private bool _failed;
        private bool _held;

        public string AgentId { get; } = agentId;

        public TaskCompletionSource<AgentReply> Completion { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task<AgentReply> Reply => Completion.Task;

        public bool TryBeginSend(object session)
        {
            lock (_gate)
            {
                if (_failed || Completion.Task.IsCompleted)
                {
                    return false;
                }

                _session = session;
                return true;
            }
        }

        /// <summary>Entrega a resposta, a menos que a espera já tenha falhado (uma só transição, sob o lock).</summary>
        public bool TryComplete(AgentReply reply)
        {
            lock (_gate)
            {
                return !_failed && Completion.TrySetResult(reply);
            }
        }

        /// <summary>Falha de vez, a não ser que já tenha terminado (resposta ou falha). Depois disto o comando não sai mais.</summary>
        public bool TryFail()
        {
            lock (_gate)
            {
                return FailLocked();
            }
        }

        /// <summary>Falha só se o comando saiu pela <paramref name="session"/> que caiu (e ainda não terminou).</summary>
        public bool TryFailIfSentOn(object session)
        {
            lock (_gate)
            {
                return ReferenceEquals(_session, session) && FailLocked();
            }
        }

        /// <summary>Falha só se a espera continua segurada pelo hold da queda.</summary>
        public bool TryFailIfHeld()
        {
            lock (_gate)
            {
                return _held && FailLocked();
            }
        }

        /// <summary>Segura a espera se o comando saiu pela <paramref name="session"/> que caiu.</summary>
        public bool TryHold(object session)
        {
            lock (_gate)
            {
                if (_failed || !ReferenceEquals(_session, session))
                {
                    return false;
                }

                _held = true;
                return true;
            }
        }

        public void Release()
        {
            lock (_gate)
            {
                _held = false;
            }
        }

        /// <summary>Quem chama segura o lock. Dali em diante <see cref="TryBeginSend"/> recusa, e o comando não sai mais.</summary>
        private bool FailLocked()
        {
            if (_failed || Completion.Task.IsCompleted)
            {
                return false;
            }

            _failed = true;
            Completion.TrySetException(new AgentDisconnectedException());
            return true;
        }

        public void Dispose() => owner._pending.TryRemove(commandId, out _);
    }
}
