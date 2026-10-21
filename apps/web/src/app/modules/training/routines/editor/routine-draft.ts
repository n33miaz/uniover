import type { LocalRoutine } from '../../data/routines/routine';
import {
  NEW_ITEM_DEFAULTS,
  ROUTINE_LIMITS,
  type RoutineItemModel,
  type RoutineModel,
} from '../../domain/routines/routine-model';
import {
  compactPositions,
  moveItem,
  toggleSupersetWithNext,
} from '../../domain/routines/supersets';
import { validateRoutine } from '../../domain/routines/validate-routine';

/** Passo do descanso nos botões de mais e menos, em segundos. */
export const REST_STEP_SECONDS = 15;

/** A rotina como o editor a mantém enquanto a pessoa mexe: uma cópia, que só vira rotina de verdade ao salvar. */
export interface RoutineDraftState {
  /** Vazio numa rotina nova. */
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly items: readonly RoutineItemModel[];
}

export function draftFromRoutine(routine: LocalRoutine): RoutineDraftState {
  return {
    id: routine.id,
    name: routine.name,
    active: routine.active,
    items: compactPositions(routine.items),
  };
}

export function emptyDraft(name = ''): RoutineDraftState {
  return { id: '', name, active: true, items: [] };
}

/** Um exercício recém-adicionado, com a meta padrão (3 séries de 8 a 12 repetições, descanso de 90 s). */
export function newDraftItem(id: string, exerciseId: string, position: number): RoutineItemModel {
  return {
    id,
    exerciseId,
    position,
    ...NEW_ITEM_DEFAULTS,
    supersetGroup: null,
    note: '',
  };
}

/** Põe o exercício no fim da rotina; `null` quando ela já está com o máximo de exercícios. */
export function appendItem(
  items: readonly RoutineItemModel[],
  item: RoutineItemModel,
): RoutineItemModel[] | null {
  if (items.length >= ROUTINE_LIMITS.maxItems) return null;
  return [...items, { ...item, position: items.length }];
}

/** Sobe (`-1`) ou desce (`+1`) um exercício. Nas pontas não muda nada. */
export function shiftItem(
  items: readonly RoutineItemModel[],
  itemId: string,
  delta: -1 | 1,
): RoutineItemModel[] {
  const index = items.findIndex((item) => item.id === itemId);
  if (index < 0) return [...items];
  return moveItem(items, itemId, index + delta);
}

/** Leva o exercício para o lugar do que está em `overId` (o arrastar). */
export function dropItemOn(
  items: readonly RoutineItemModel[],
  itemId: string,
  overId: string,
): RoutineItemModel[] {
  const to = items.findIndex((item) => item.id === overId);
  if (to < 0) return [...items];
  return moveItem(items, itemId, to);
}

/** "Juntar com o próximo (supersérie)": liga ou desliga o exercício ao seguinte. */
export function toggleLink(items: readonly RoutineItemModel[], itemId: string): RoutineItemModel[] {
  const index = items.findIndex((item) => item.id === itemId);
  return index < 0 ? [...items] : toggleSupersetWithNext(items, index);
}

export function removeItem(items: readonly RoutineItemModel[], itemId: string): RoutineItemModel[] {
  return compactPositions(items.filter((item) => item.id !== itemId));
}

export type ItemField = 'targetSets' | 'repMin' | 'repMax' | 'restSeconds';

const FIELD_RANGE: Record<ItemField, readonly [number, number]> = {
  targetSets: [ROUTINE_LIMITS.setsMin, ROUTINE_LIMITS.setsMax],
  repMin: [ROUTINE_LIMITS.repsMin, ROUTINE_LIMITS.repsMax],
  repMax: [ROUTINE_LIMITS.repsMin, ROUTINE_LIMITS.repsMax],
  restSeconds: [0, ROUTINE_LIMITS.restMax],
};

/** Soma `delta` ao campo, sem passar dos limites da rotina. O descanso anda de 15 em 15 segundos. */
export function stepItem(
  items: readonly RoutineItemModel[],
  itemId: string,
  field: ItemField,
  direction: -1 | 1,
): RoutineItemModel[] {
  const [min, max] = FIELD_RANGE[field];
  const amount = field === 'restSeconds' ? REST_STEP_SECONDS * direction : direction;
  return items.map((item) => {
    if (item.id !== itemId) return item;
    const next = Math.min(max, Math.max(min, item[field] + amount));
    return next === item[field] ? item : { ...item, [field]: next };
  });
}

/** O que está errado numa rotina, por campo, sem texto (a tela escolhe a mensagem). */
export interface DraftErrors {
  readonly name?: 'missing' | 'too-long';
  readonly items?: 'missing' | 'too-many' | 'superset';
  /** Por id do exercício: a faixa de repetições invertida ou fora dos limites. */
  readonly reps: ReadonlySet<string>;
}

export function validateDraft(draft: RoutineDraftState): DraftErrors {
  const name = draft.name.trim();
  const model: RoutineModel = {
    id: draft.id || 'novo',
    name: draft.name,
    position: 0,
    active: draft.active,
    note: '',
    items: draft.items,
  };
  const issues = validateRoutine(model);
  const reps = new Set<string>();
  let items: DraftErrors['items'];
  for (const issue of issues) {
    const match = /^items\[(\d+)\]\.reps$/.exec(issue.path);
    if (match) reps.add(draft.items[Number(match[1])].id);
    else if (issue.code === 'too-many-items') items = 'too-many';
    else if (issue.code === 'superset-not-contiguous') items = 'superset';
  }
  if (draft.items.length === 0) items = 'missing';
  return {
    name: name === '' ? 'missing' : name.length > ROUTINE_LIMITS.nameMax ? 'too-long' : undefined,
    items,
    reps,
  };
}

export function hasErrors(errors: DraftErrors): boolean {
  return errors.name !== undefined || errors.items !== undefined || errors.reps.size > 0;
}

/** O rascunho mudou desde que foi aberto? O nome com espaço nas pontas não conta como mudança. */
export function isDraftDirty(initial: RoutineDraftState, current: RoutineDraftState): boolean {
  const normal = (draft: RoutineDraftState) =>
    JSON.stringify([draft.name.trim(), draft.active, draft.items]);
  return normal(initial) !== normal(current);
}

/** Os dados que o repositório grava, na ordem da lista do editor. */
export function toSaveDraft(draft: RoutineDraftState) {
  return {
    id: draft.id === '' ? undefined : draft.id,
    name: draft.name,
    active: draft.active,
    items: draft.items.map((item) => ({
      id: item.id,
      exerciseId: item.exerciseId,
      targetSets: item.targetSets,
      repMin: item.repMin,
      repMax: item.repMax,
      restSeconds: item.restSeconds,
      supersetGroup: item.supersetGroup,
      note: item.note,
    })),
  };
}
