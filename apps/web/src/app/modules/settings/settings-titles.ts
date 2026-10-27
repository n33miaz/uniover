import { AccountRole } from '../../core/session/session-state';

/**
 * Nomes das telas de Configurações: o mesmo texto na lista, no cabeçalho de cada tela (o `data.title` da rota) e no que o
 * leitor de tela anuncia. Um lugar só, para a lista e as rotas nunca se desencontrarem.
 */
export const SETTINGS_TITLES = {
  profile: $localize`:@@settings.route.profile:Perfil`,
  appearance: $localize`:@@settings.route.appearance:Aparência`,
  security: $localize`:@@settings.route.security:Segurança`,
  people: $localize`:@@settings.route.people:Pessoas e Permissões`,
  audit: $localize`:@@settings.route.audit:Auditoria`,
  system: $localize`:@@settings.route.system:Sistema`,
  about: $localize`:@@settings.route.about:Sobre`,
} as const;

/** Como o papel aparece nas telas: o dono é o "Administrador". `null` (papel ainda desconhecido) não tem rótulo. */
export function roleLabel(role: AccountRole | null): string | null {
  switch (role) {
    case 'owner':
      return $localize`:@@settings.role.admin:Administrador`;
    case 'guest':
      return $localize`:@@settings.role.guest:Convidado`;
    default:
      return null;
  }
}

/**
 * O que cada permissão do catálogo da API quer dizer, em linguagem de gente. A permissão de módulo da TV (`module:tv`)
 * só vira uma linha quando é a única da TV: com qualquer ação da TV ela já está dita ("Controlar a TV"). Permissão
 * que a tela ainda não conhece fica de fora (a lista nunca mostra um identificador técnico).
 */
export function permissionLabels(permissions: readonly string[]): readonly string[] {
  const has = (permission: string) => permissions.includes(permission);
  const labels: string[] = [];
  const tvActions = ['tv:control', 'tv:power', 'tv:launch', 'tv:edit-shortcuts', 'tv:history'];
  if (has('module:tv') && !tvActions.some(has)) {
    labels.push($localize`:@@settings.permission.tv-view:Ver a TV`);
  }
  if (has('tv:control')) labels.push($localize`:@@settings.permission.tv-control:Controlar a TV`);
  if (has('tv:power')) labels.push($localize`:@@settings.permission.tv-power:Desligar a TV`);
  if (has('tv:launch')) labels.push($localize`:@@settings.permission.tv-launch:Abrir apps`);
  if (has('tv:edit-shortcuts')) {
    labels.push($localize`:@@settings.permission.tv-edit:Editar atalhos`);
  }
  if (has('tv:history')) labels.push($localize`:@@settings.permission.tv-history:Ver o histórico`);
  if (has('module:training')) {
    labels.push($localize`:@@settings.permission.training:Usar o Treino`);
  }
  return labels;
}
