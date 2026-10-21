using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Training;

/// <summary>
/// Políticas de autorização das rotas do Treino. As rotas de dado do usuário exigem a permissão <c>module:training</c>
/// (<see cref="AccessPermissions"/>): o administrador passa sempre e o convidado precisa da concessão, lida do banco com
/// cache curto (nunca do JWT). Cada rota declara a sua política (nunca o grupo): uma rota nova sem política nomeada cai na
/// padrão (só administrador), e o convidado nunca a alcança por esquecimento.
/// </summary>
internal static class TrainingAuth
{
    /// <summary>
    /// Usar o Treino: ler e gravar os dados da PRÓPRIA conta (rotinas, treinos, séries, metas, exercícios próprios) e ler o
    /// catálogo compartilhado. Toda consulta e toda escrita filtram pelo usuário da sessão; a permissão só abre a porta.
    /// </summary>
    internal static readonly string Module = AccessPermissions.Policy(AccessPermissions.TrainingModule);

    /// <summary>
    /// Escrever dado GLOBAL (o catálogo compartilhado, como a importação do wger): só o administrador, mesmo para quem tem
    /// <c>module:training</c>. Um membro do Treino nunca altera o que todos os outros usuários enxergam.
    /// </summary>
    internal const string AdminOnly = UniOverAuth.OwnerPolicy;
}
