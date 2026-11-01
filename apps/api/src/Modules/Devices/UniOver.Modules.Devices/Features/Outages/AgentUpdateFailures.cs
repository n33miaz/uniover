using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Devices.Domain;

namespace UniOver.Modules.Devices.Features.Outages;

/// <summary>
/// Quais ocorrências do agente viram o aviso "Falha de Atualização" do dono: as de tipo <c>update.*</c> com severidade
/// <c>error</c> (<c>update.failed</c>, <c>update.rejected</c>, <c>update.sync_failed</c>, <c>update.rollback_failed</c> e a volta
/// automática <c>update.rolled_back</c>). A volta que o próprio dono pediu chega como <c>warn</c> e não conta, nem as ocorrências
/// de rotina (<c>update.installed</c>, <c>update.confirmed</c>).
/// </summary>
internal static class AgentUpdateFailures
{
    public const string KindPrefix = "update.";

    public const string ErrorSeverity = "error";

    /// <summary>As falhas de atualização que o dono ainda não viu.</summary>
    public static IQueryable<AgentDiagnosticEvent> UnseenUpdateFailures(this IQueryable<AgentDiagnosticEvent> events) =>
        events.Where(e => e.SeenAt == null && e.Severity == ErrorSeverity && e.Kind.StartsWith(KindPrefix));
}
