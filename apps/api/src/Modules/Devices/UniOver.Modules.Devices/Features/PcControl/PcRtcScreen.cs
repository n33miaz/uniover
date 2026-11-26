using Microsoft.Extensions.Configuration;
using UniOver.Modules.Devices.Domain;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>
/// A flag <c>pc_screen</c> (configuração <c>Modules:Devices:PcScreen:Enabled</c>, desligada por padrão): com ela desligada a API
/// recusa qualquer oferta do escopo da tela, mesmo do dono com a permissão.
/// </summary>
internal static class PcRtcAudit
{
    /// <summary>O fechamento de um canal só da tela tem evento próprio; os demais seguem como sempre.</summary>
    public static string ClosedEvent(PcRtcSession session) =>
        session.Scopes == PcRtcScopes.Screen ? PairingEvents.PcScreenClosed : PairingEvents.PcDirectClosed;
}

internal sealed class PcScreenFlag(IConfiguration configuration)
{
    public const string ConfigurationKey = "Modules:Devices:PcScreen:Enabled";

    public bool Enabled => bool.TryParse(configuration[ConfigurationKey], out var enabled) && enabled;
}
