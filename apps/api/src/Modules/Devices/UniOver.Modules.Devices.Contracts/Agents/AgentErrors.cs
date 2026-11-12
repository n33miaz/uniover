using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Contracts.Agents;

/// <summary>Falhas tipadas do <see cref="IAgentGateway"/>; os códigos são estáveis para quem chama.</summary>
public static class AgentErrors
{
    public const string OfflineCode = "agent_offline";
    public const string TimeoutCode = "agent_timeout";
    public const string InvalidMessageCode = "invalid_message";
    public const string StalledCode = "agent_stalled";

    /// <summary>Não há sessão viva com o agente: nada é enviado nem esperado.</summary>
    public static Error Offline { get; } = new(OfflineCode, "O agente não está conectado.");

    /// <summary>O agente recebeu o comando mas não respondeu a tempo (a resposta tardia é descartada).</summary>
    public static Error Timeout { get; } = new(TimeoutCode, "O agente não respondeu a tempo.");

    /// <summary>
    /// O agente está conectado, mas mudo (laço parado, PC paginado): o comando nem saiu, e a falha volta na hora em vez de
    /// esperar o prazo inteiro. Quem mostra à pessoa deve dizer "PC lento", não "desligado".
    /// </summary>
    public static Error Stalled { get; } = new(StalledCode, "O agente está conectado, mas não responde.");

    /// <summary>A mensagem montada não cumpre o contrato: erro de quem chama, nunca chega ao agente.</summary>
    public static Error InvalidMessage(string detail) => new(InvalidMessageCode, detail);
}
