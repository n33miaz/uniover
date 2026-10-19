import { ROUTINE_LIMITS, type RoutineModel } from './routine-model';
import { compactPositions } from './supersets';

/**
 * O que está errado, sem texto: a tela escolhe a mensagem (i18n). `path` aponta o campo (`name`, `items[2].repMax`).
 */
export type RoutineIssueCode =
  | 'name-length'
  | 'position-range'
  | 'note-length'
  | 'too-many-items'
  | 'item-id-missing'
  | 'item-id-duplicate'
  | 'item-exercise-missing'
  | 'item-position-range'
  | 'item-sets-range'
  | 'item-reps-range'
  | 'item-rest-range'
  | 'item-note-length'
  | 'item-superset-range'
  | 'superset-not-contiguous';

export interface RoutineIssue {
  readonly path: string;
  readonly code: RoutineIssueCode;
}

function outside(value: number, min: number, max: number): boolean {
  return !Number.isInteger(value) || value < min || value > max;
}

/**
 * Confere a rotina com os mesmos limites da API (nome 1 a 80, até 40 itens, séries 1 a 20, repetições 1 a 100 com o
 * mínimo não maior que o máximo, descanso 0 a 1800 s, supersérie só entre vizinhos). Lista vazia = pode salvar.
 * Um grupo de supersérie com um item só não é erro: a gravação o normaliza para "sem supersérie".
 */
export function validateRoutine(routine: RoutineModel): RoutineIssue[] {
  const issues: RoutineIssue[] = [];
  const add = (path: string, code: RoutineIssueCode) => issues.push({ path, code });

  const name = routine.name.trim();
  if (name.length < 1 || name.length > ROUTINE_LIMITS.nameMax) add('name', 'name-length');
  if (outside(routine.position, 0, ROUTINE_LIMITS.positionMax)) add('position', 'position-range');
  if (routine.note.trim().length > ROUTINE_LIMITS.noteMax) add('note', 'note-length');

  if (routine.items.length > ROUTINE_LIMITS.maxItems) {
    add('items', 'too-many-items');
    return issues;
  }

  const seen = new Set<string>();
  routine.items.forEach((item, index) => {
    const at = `items[${index}]`;
    if (item.id === '') add(`${at}.id`, 'item-id-missing');
    else if (seen.has(item.id)) add(`${at}.id`, 'item-id-duplicate');
    seen.add(item.id);
    if (item.exerciseId === '') add(`${at}.exerciseId`, 'item-exercise-missing');
    if (outside(item.position, 0, ROUTINE_LIMITS.positionMax))
      add(`${at}.position`, 'item-position-range');
    if (outside(item.targetSets, ROUTINE_LIMITS.setsMin, ROUTINE_LIMITS.setsMax))
      add(`${at}.targetSets`, 'item-sets-range');
    if (
      outside(item.repMin, ROUTINE_LIMITS.repsMin, ROUTINE_LIMITS.repsMax) ||
      outside(item.repMax, ROUTINE_LIMITS.repsMin, ROUTINE_LIMITS.repsMax) ||
      item.repMin > item.repMax
    )
      add(`${at}.reps`, 'item-reps-range');
    if (outside(item.restSeconds, 0, ROUTINE_LIMITS.restMax))
      add(`${at}.restSeconds`, 'item-rest-range');
    if (item.note.trim().length > ROUTINE_LIMITS.itemNoteMax) add(`${at}.note`, 'item-note-length');
    if (
      item.supersetGroup !== null &&
      outside(item.supersetGroup, ROUTINE_LIMITS.supersetGroupMin, ROUTINE_LIMITS.supersetGroupMax)
    )
      add(`${at}.supersetGroup`, 'item-superset-range');
  });

  // Mesmo número em dois trechos separados por outro item não é supersérie (o servidor responderia 422).
  const closed = new Set<number>();
  let current: number | null = null;
  for (const item of compactPositions(routine.items)) {
    if (item.supersetGroup === current) continue;
    if (current !== null) closed.add(current);
    current = item.supersetGroup;
    if (current !== null && closed.has(current)) {
      add('items', 'superset-not-contiguous');
      break;
    }
  }

  return issues;
}
