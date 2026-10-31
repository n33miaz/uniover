import { permissionLabels } from './settings-titles';

export const TV_MODULE = 'module:tv';
export const TRAINING_MODULE = 'module:training';
export const PC_MODULE = 'module:pc';

/** As ações da TV: cada uma só vale com o módulo da TV (a API recusa a lista que traga uma sem ele). */
export const TV_ACTIONS = [
  'tv:control',
  'tv:power',
  'tv:launch',
  'tv:edit-shortcuts',
  'tv:history',
] as const;

/** O catálogo fechado de permissões da API, na ordem em que ela o devolve (a mesma ordem vale para o que a tela envia). */
export const CATALOG: readonly string[] = [TV_MODULE, ...TV_ACTIONS, TRAINING_MODULE, PC_MODULE];

const MODULES: readonly string[] = [TV_MODULE, TRAINING_MODULE, PC_MODULE];

/** Modelo "só controlar a TV": o mesmo que a API concede a um convite sem lista (a TV inteira, menos editar atalhos). */
export const TV_CONTROL_ONLY: readonly string[] = [
  TV_MODULE,
  'tv:control',
  'tv:power',
  'tv:launch',
  'tv:history',
];

/** Modelo "só o Treino": o módulo e nada da TV. */
export const TRAINING_ONLY: readonly string[] = [TRAINING_MODULE];

/** Os modelos prontos do seletor; `custom` é "o que não bate com nenhum modelo". */
export type PermissionModel = 'tv-control' | 'training' | 'custom';

function isKnown(permission: string): boolean {
  return CATALOG.includes(permission);
}

/**
 * Sem repetidas, as do catálogo na ordem dele e, depois, as que a tela não conhece. Estas últimas só existem se a API
 * ganhar uma permissão antes de a tela (a página instalada pode estar uma versão atrás): a tela as devolve como estão
 * em vez de, sem querer, tirá-las de quem já as tem.
 */
export function normalizePermissions(permissions: readonly string[]): readonly string[] {
  const wanted = new Set(permissions);
  return [
    ...CATALOG.filter((permission) => wanted.has(permission)),
    ...[...wanted].filter((permission) => !isKnown(permission)),
  ];
}

/** O que a tela conhece de uma lista (sem as permissões novas da API que ela ainda não sabe nomear). */
function known(permissions: readonly string[]): readonly string[] {
  return permissions.filter(isKnown);
}

/**
 * Aplica o que a pessoa fez num interruptor, sempre sem recusar o toque: ligar qualquer ação da TV liga também "ver a
 * TV"; desligar "ver a TV" desliga todas as ações dela. O resultado já sai normalizado.
 */
export function togglePermission(
  current: readonly string[],
  permission: string,
  on: boolean,
): readonly string[] {
  const next = new Set(current);
  if (on) {
    next.add(permission);
    if ((TV_ACTIONS as readonly string[]).includes(permission)) next.add(TV_MODULE);
  } else {
    next.delete(permission);
    if (permission === TV_MODULE) for (const action of TV_ACTIONS) next.delete(action);
  }
  return normalizePermissions([...next]);
}

/** Mesma lista, sem olhar a ordem. */
export function samePermissions(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((permission) => right.has(permission));
}

/** Ao menos um módulo ligado: sem isso a pessoa não teria acesso a nada (e a API recusa a lista). */
export function hasModule(permissions: readonly string[]): boolean {
  return permissions.some((permission) => MODULES.includes(permission));
}

/** Qual modelo pronto a lista é (só conta o que a tela conhece); `custom` se não for nenhum. */
export function modelOf(permissions: readonly string[]): PermissionModel {
  const list = known(permissions);
  if (samePermissions(list, TV_CONTROL_ONLY)) return 'tv-control';
  if (samePermissions(list, TRAINING_ONLY)) return 'training';
  return 'custom';
}

/** Troca o que a tela conhece pelo modelo, mantendo o que ela não sabe nomear (ver `normalizePermissions`). */
export function applyModel(
  current: readonly string[],
  model: Exclude<PermissionModel, 'custom'>,
): readonly string[] {
  const kept = current.filter((permission) => !isKnown(permission));
  return normalizePermissions([
    ...(model === 'tv-control' ? TV_CONTROL_ONLY : TRAINING_ONLY),
    ...kept,
  ]);
}

/**
 * O resumo de uma linha do que a pessoa poderá fazer, com a MESMA tabela de frases do Perfil (`permissionLabels`).
 * Sem nenhum módulo ele diz isso, em vez de uma lista vazia.
 */
export function permissionSummary(permissions: readonly string[]): string {
  if (!hasModule(permissions)) return noModuleText();
  return permissionLabels(permissions).join(' · ');
}

/** O aviso de quando nada está ligado; aparece no lugar do resumo e é a razão de "Gerar convite" e "Salvar" ficarem apagados. */
export function noModuleText(): string {
  return $localize`:@@settings.people.no-module:Ligue ao menos um módulo. Para tirar todo o acesso, revogue a pessoa.`;
}

/** A frase de cada interruptor, em linguagem de gente (os rótulos curtos do resumo ficam em `permissionLabels`). */
export function permissionOptionLabel(permission: string): string {
  switch (permission) {
    case TV_MODULE:
      return $localize`:@@settings.people.option.tv-view:Ver a TV`;
    case 'tv:control':
      return $localize`:@@settings.people.option.tv-control:Usar o controle e o teclado`;
    case 'tv:power':
      return $localize`:@@settings.people.option.tv-power:Desligar a TV`;
    case 'tv:launch':
      return $localize`:@@settings.people.option.tv-launch:Abrir apps e atualizar a lista`;
    case 'tv:edit-shortcuts':
      return $localize`:@@settings.people.option.tv-edit:Editar e reordenar atalhos`;
    case 'tv:history':
      return $localize`:@@settings.people.option.tv-history:Ver o histórico`;
    case TRAINING_MODULE:
      return $localize`:@@settings.people.option.training:Usar o Treino`;
    case PC_MODULE:
      return $localize`:@@settings.people.option.pc:Controlar o PC`;
    default:
      return permission;
  }
}

/** O nome de cada modelo pronto nos botões do seletor. */
export function modelLabel(model: PermissionModel): string {
  switch (model) {
    case 'tv-control':
      return $localize`:@@settings.people.model.tv-control:Só controlar a TV`;
    case 'training':
      return $localize`:@@settings.people.model.training:Só o Treino`;
    default:
      return $localize`:@@settings.people.model.custom:Personalizado`;
  }
}
