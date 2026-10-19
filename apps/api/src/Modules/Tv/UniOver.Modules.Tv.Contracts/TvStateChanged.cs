using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Contracts;

/// <summary>
/// O estado da TV mudou em <c>power</c>, <c>app</c> ou <c>connection</c> (volume nunca dispara este evento).
/// Imutável depois de publicado. Só id do agente (slug), valores simples e instantes.
/// </summary>
/// <param name="Power"><c>on</c>, <c>off</c> ou <c>unknown</c>.</param>
/// <param name="Connection"><c>hot</c>, <c>hibernating</c> ou <c>disconnected</c>.</param>
/// <param name="At">Instante em que o agente observou o estado.</param>
public sealed record TvStateChanged(
    Guid Id,
    DateTimeOffset OccurredAt,
    string AgentId,
    string Power,
    string? App,
    string Connection,
    DateTimeOffset At) : IIntegrationEvent
{
    public const string EventType = "tv.state-changed.v1";

    public string Type => EventType;
}
