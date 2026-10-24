using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Contracts;

namespace UniOver.Modules.Tv;

/// <summary>
/// Políticas de autorização das rotas da TV, uma por permissão do catálogo (<see cref="AccessPermissions"/>): o
/// administrador passa sempre e o convidado precisa da concessão, lida do banco com cache curto (nunca do JWT). Cada
/// política já inclui o papel conhecido e a conta ativa. Rota nova sem política nomeada cai na padrão (só administrador).
/// </summary>
public static class TvAuth
{
    /// <summary>
    /// Fluxo SSE da TV: só o cookie de bilhete, só GET, e a permissão <c>module:tv</c>. Existe como política própria
    /// (e não como a política genérica da permissão) porque as políticas por permissão autenticam pelo cabeçalho
    /// Authorization, e o fluxo só pode abrir com o bilhete em cookie (nunca com o JWT de acesso nem com token na URL).
    /// </summary>
    public const string StreamPolicy = "TvStream";

    /// <summary>
    /// Ação de confirmação de trocar o computador que controla a TV. Redireciona o controle para outra máquina, então só
    /// o administrador, e só com a passkey (a política <c>stepup:</c> já inclui o papel de administrador). Mora aqui,
    /// como a do pareamento mora no Devices: o Identity não precisa conhecer as ações dos outros módulos.
    /// </summary>
    public const string BindAgentAction = TvPairingActions.BindAgent;

    /// <summary>Ver a TV: estado, lista de atalhos e o fluxo ao vivo (<c>module:tv</c>).</summary>
    internal static readonly string Module = AccessPermissions.Policy(AccessPermissions.TvModule);

    /// <summary>Teclas, texto, acordar e limpar a TV (<c>tv:control</c>).</summary>
    internal static readonly string Control = AccessPermissions.Policy(AccessPermissions.TvControl);

    /// <summary>Desligar a TV (<c>tv:power</c>).</summary>
    internal static readonly string Power = AccessPermissions.Policy(AccessPermissions.TvPower);

    /// <summary>Abrir aplicativos e atualizar a lista deles (<c>tv:launch</c>).</summary>
    internal static readonly string Launch = AccessPermissions.Policy(AccessPermissions.TvLaunch);

    /// <summary>Renomear, ocultar e reordenar os atalhos (<c>tv:edit-shortcuts</c>).</summary>
    internal static readonly string EditShortcuts = AccessPermissions.Policy(AccessPermissions.TvEditShortcuts);

    /// <summary>Ler o histórico de comandos (<c>tv:history</c>); quem não é administrador vê só os próprios.</summary>
    internal static readonly string History = AccessPermissions.Policy(AccessPermissions.TvHistory);
}
