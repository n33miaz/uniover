/**
 * Modelo e limites do treino ao vivo (sessão e séries). Funções e tipos puros: nada de Angular, banco ou rede. Os
 * limites são os mesmos da API, para o que ela recusaria nem entrar na fila de escrita.
 */

export const SESSION_LIMITS = {
  noteMax: 500,
  setNoteMax: 300,
  deviceIdMax: 64,
  feelingMin: 1,
  feelingMax: 5,
  positionMax: 100000,
  repsMax: 999,
  rirMax: 10,
  rpeMin: 1,
  rpeMax: 10,
  durationMaxSeconds: 86400,
  weightMaxKg: 99999.99,
} as const;

/** Tipos de série, com os mesmos valores da API. */
export const SET_TYPES = ['warmup', 'work', 'failure', 'drop'] as const;
export type SetType = (typeof SET_TYPES)[number];

/** Como as séries de um exercício são registradas (o `recordType` do exercício). */
export type RecordType = 'weight_reps' | 'reps_only' | 'time';

/** Tipo de série padrão ("Concluir série" sem escolher). */
export const DEFAULT_SET_TYPE: SetType = 'work';

/** Um treino como a tela o enxerga. */
export interface SessionModel {
  readonly id: string;
  /** Rotina que originou o treino; `null` no treino livre. */
  readonly routineId: string | null;
  /** Instantes em milissegundos. */
  readonly startedAt: number;
  /** `null` enquanto o treino está em andamento. */
  readonly finishedAt: number | null;
  /** Vazio quando não há anotação. */
  readonly note: string;
  /** Como o dono se sentiu, de 1 a 5; `null` se não disse. */
  readonly feeling: number | null;
  /** Aparelho que abriu o treino. */
  readonly deviceId: string;
}

/** Uma série registrada. */
export interface SetModel {
  readonly id: string;
  readonly sessionId: string;
  readonly exerciseId: string;
  /** Ordem da série dentro da sessão. */
  readonly position: number;
  readonly setType: SetType;
  /** Carga em kg (nos halteres, a de um halter). */
  readonly weightKg: number | null;
  readonly reps: number | null;
  /** Duração em segundos, nos exercícios de tipo tempo. */
  readonly durationS: number | null;
  /** Repetições em reserva (0 a 10). */
  readonly rir: number | null;
  /** Esforço percebido (1 a 10, em passos de 0,5). */
  readonly rpe: number | null;
  /** Vazio quando não há anotação. */
  readonly note: string;
  /** Instante (ms) em que a série foi concluída. */
  readonly completedAt: number;
}

/** Série de trabalho = qualquer uma que não seja aquecimento (inclui falha e drop). */
export function isWorkingSet(setType: string): boolean {
  return setType !== 'warmup';
}

/** O que a tela preenche numa série (antes de ganhar id, posição e instantes). */
export interface SetValues {
  readonly setType: SetType;
  readonly weightKg: number | null;
  readonly reps: number | null;
  readonly durationS: number | null;
  readonly rir: number | null;
  readonly rpe: number | null;
  readonly note: string;
}

/** O que está errado numa série, sem texto: a tela escolhe a mensagem (i18n). */
export type SetIssueCode =
  | 'set-type-invalid'
  | 'weight-range'
  | 'reps-range'
  | 'duration-range'
  | 'rir-range'
  | 'rpe-range'
  | 'note-length'
  | 'reps-required'
  | 'weight-required'
  | 'duration-required';

export interface SetIssue {
  readonly path: keyof SetValues;
  readonly code: SetIssueCode;
}

function outsideInt(value: number, min: number, max: number): boolean {
  return !Number.isInteger(value) || value < min || value > max;
}

/**
 * Confere a série com os mesmos limites da API e, quando se sabe o tipo de registro do exercício, a forma que ele
 * exige: `weight_reps` pede repetições (e carga na série de tipo `work`), `reps_only` pede repetições, `time` pede a
 * duração. Lista vazia = pode gravar.
 */
export function validateSet(values: SetValues, recordType: string | null): SetIssue[] {
  const issues: SetIssue[] = [];
  const add = (path: keyof SetValues, code: SetIssueCode) => issues.push({ path, code });

  if (!SET_TYPES.includes(values.setType)) add('setType', 'set-type-invalid');

  const weight = values.weightKg;
  if (
    weight !== null &&
    (!Number.isFinite(weight) ||
      weight < 0 ||
      weight > SESSION_LIMITS.weightMaxKg ||
      Math.abs(weight * 100 - Math.round(weight * 100)) > 1e-6)
  ) {
    add('weightKg', 'weight-range');
  }
  if (values.reps !== null && outsideInt(values.reps, 0, SESSION_LIMITS.repsMax)) {
    add('reps', 'reps-range');
  }
  if (
    values.durationS !== null &&
    outsideInt(values.durationS, 0, SESSION_LIMITS.durationMaxSeconds)
  ) {
    add('durationS', 'duration-range');
  }
  if (values.rir !== null && outsideInt(values.rir, 0, SESSION_LIMITS.rirMax)) {
    add('rir', 'rir-range');
  }
  if (
    values.rpe !== null &&
    (!Number.isFinite(values.rpe) ||
      values.rpe < SESSION_LIMITS.rpeMin ||
      values.rpe > SESSION_LIMITS.rpeMax ||
      values.rpe * 2 !== Math.round(values.rpe * 2))
  ) {
    add('rpe', 'rpe-range');
  }
  if (values.note.trim().length > SESSION_LIMITS.setNoteMax) add('note', 'note-length');

  if (recordType === 'weight_reps') {
    if (values.reps === null) add('reps', 'reps-required');
    if (values.setType === 'work' && values.weightKg === null) add('weightKg', 'weight-required');
  } else if (recordType === 'reps_only') {
    if (values.reps === null) add('reps', 'reps-required');
  } else if (recordType === 'time') {
    if (values.durationS === null) add('durationS', 'duration-required');
  }

  return issues;
}

/** O que está errado ao encerrar um treino (sensação e anotação). */
export type FinishIssueCode = 'feeling-range' | 'note-length';

export function validateFinish(feeling: number | null, note: string): FinishIssueCode[] {
  const issues: FinishIssueCode[] = [];
  if (
    feeling !== null &&
    outsideInt(feeling, SESSION_LIMITS.feelingMin, SESSION_LIMITS.feelingMax)
  ) {
    issues.push('feeling-range');
  }
  if (note.trim().length > SESSION_LIMITS.noteMax) issues.push('note-length');
  return issues;
}
