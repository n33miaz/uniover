import type { LocalExercise } from '../data/catalog/exercise';
import type { SetDraft as RepositoryDraft } from '../data/sessions/session-repository';
import { SESSION_LIMITS } from '../domain/session/session-model';
import { effectiveStepKg } from '../domain/taxonomy';

/**
 * O que se preenche numa série antes de concluí-la (o cartão da série atual e a folha de editar usam o mesmo formato).
 * `null` é "ainda sem valor": o campo aparece vazio e "Concluir série" diz o que falta.
 */
export interface SetFields {
  readonly weightKg: number | null;
  readonly reps: number | null;
  readonly durationS: number | null;
  /** Esforço percebido (6 a 10 nos botões); `null` = não informado. */
  readonly rpe: number | null;
  readonly warmup: boolean;
  readonly note: string;
}

export const EMPTY_FIELDS: SetFields = {
  weightKg: null,
  reps: null,
  durationS: null,
  rpe: null,
  warmup: false,
  note: '',
};

/** Botões do esforço percebido: de 6 a 10 (abaixo disso o esforço é leve demais para anotar). Tocar de novo limpa. */
export const RPE_CHOICES: readonly number[] = [6, 7, 8, 9, 10];

/** Passo de repetições e de duração (segundos). */
export const REPS_STEP = 1;
export const DURATION_STEP_S = 5;

export const NOTE_MAX = SESSION_LIMITS.setNoteMax;

/**
 * Salto da carga do exercício: o do dono, ou o do equipamento (barra 2,5 kg, halteres 2 kg, máquina e polia 5 kg). Sem
 * salto (peso do corpo, "outro"), um quilo: o botão nunca fica sem efeito.
 */
export function loadStepFor(
  exercise: Pick<LocalExercise, 'stepKg' | 'equipment'> | undefined,
): number {
  const step = exercise ? effectiveStepKg(exercise) : 0;
  return step > 0 ? step : 1;
}

/** Soma ou tira um passo, sem erro de ponto flutuante (42,5 + 2,5 é 45, não 44,99999). Nunca sai de [min, max]. */
export function bumpValue(
  value: number | null,
  direction: 1 | -1,
  step: number,
  min: number,
  max: number,
): number {
  const next = Math.round(((value ?? 0) + direction * step) * 100) / 100;
  return Math.min(max, Math.max(min, next));
}

export type ParsedField =
  { readonly ok: true; readonly value: number | null } | { readonly ok: false };

/**
 * Lê o que a pessoa digitou. Aceita vírgula ou ponto; carga tem até duas casas, o resto é inteiro. Vazio é "sem valor";
 * o que não é número é recusado (o campo volta ao valor anterior).
 */
export function parseField(text: string, decimal: boolean): ParsedField {
  const clean = text.trim().replace(',', '.');
  if (clean === '') return { ok: true, value: null };
  const pattern = decimal ? /^\d{1,5}(\.\d{1,2})?$/ : /^\d{1,5}$/;
  return pattern.test(clean) ? { ok: true, value: Number(clean) } : { ok: false };
}

const numberFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

/** O número como aparece no campo ("42,5"); vazio quando não há valor. */
export function formatField(value: number | null): string {
  return value === null ? '' : numberFormat.format(value);
}

/** O que `SessionRepository.addSet` recebe, a partir do que está no cartão e do tipo de registro do exercício. */
export function toRepositoryDraft(
  exercise: Pick<LocalExercise, 'id' | 'recordType'>,
  fields: SetFields,
): RepositoryDraft {
  const withLoad = exercise.recordType === 'weight_reps';
  const timed = exercise.recordType === 'time';
  return {
    exerciseId: exercise.id,
    setType: fields.warmup ? 'warmup' : 'work',
    weightKg: withLoad ? fields.weightKg : null,
    reps: timed ? null : fields.reps,
    durationS: timed ? fields.durationS : null,
    rpe: fields.rpe,
    note: fields.note,
  };
}
