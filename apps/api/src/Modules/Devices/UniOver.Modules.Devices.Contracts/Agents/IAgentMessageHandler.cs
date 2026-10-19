namespace UniOver.Modules.Devices.Contracts.Agents;

/// <summary>
/// Quem trata mensagens que o agente envia por iniciativa própria (ex.: o módulo da TV trata o estado). O módulo
/// interessado implementa e registra no contêiner; o Devices descobre por injeção e nunca referencia quem trata.
/// A mensagem já foi validada contra o contrato; o tratamento deve ser rápido, porque a leitura do agente espera por ele.
/// </summary>
public interface IAgentMessageHandler
{
    /// <summary>Os valores de <c>type</c> que este tratador quer receber.</summary>
    IReadOnlyCollection<string> HandledTypes { get; }

    Task HandleAsync(InboundMessage message, CancellationToken cancellationToken);
}
