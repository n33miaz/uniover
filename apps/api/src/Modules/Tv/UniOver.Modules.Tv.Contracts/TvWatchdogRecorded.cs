using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Contracts;

/// <summary>
/// O vigia que mantém o controle da TV de pé registrou um evento (porta fechada, reparo, recuperação...).
/// Imutável depois de publicado. Só id do agente (slug), valores simples e instantes.
/// </summary>
/// <param name="Kind">Ex.: <c>port_closed</c>, <c>repair_started</c>, <c>repaired</c>, <c>recovered</c>.</param>
/// <param name="Severity"><c>info</c>, <c>warn</c> ou <c>error</c>.</param>
/// <param name="At">Instante em que o agente observou o evento.</param>
public sealed record TvWatchdogRecorded(
    Guid Id,
    DateTimeOffset OccurredAt,
    string AgentId,
    string Kind,
    string Severity,
    string Detail,
    int Attempts,
    DateTimeOffset At) : IIntegrationEvent
{
    public const string EventType = "tv.watchdog-recorded.v1";

    public string Type => EventType;
}
