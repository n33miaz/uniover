import { normalizeText } from '../../domain/text-search';
import { EQUIPMENT_IDS, RECORD_TYPES, isMuscleId } from '../../domain/taxonomy';

/** Os mesmos limites do servidor (e do `CatalogWriter`): o que ele recusaria não deve nem tentar salvar. */
export const EXERCISE_LIMITS = {
  nameMax: 120,
  stepsMax: 20,
  stepMax: 500,
} as const;

/** O que a pessoa preenche no formulário de exercício próprio. */
export interface ExerciseForm {
  readonly name: string;
  /** Id do músculo principal, ou vazio enquanto não escolheu. */
  readonly muscle: string;
  readonly equipment: string;
  readonly recordType: string;
  /** Instruções como foram digitadas: um passo por linha. */
  readonly steps: string;
}

export const EMPTY_EXERCISE_FORM: ExerciseForm = {
  name: '',
  muscle: '',
  equipment: 'barbell',
  recordType: 'weight_reps',
  steps: '',
};

/** O que está errado, sem texto: a tela escolhe a mensagem (i18n). */
export type ExerciseFormIssue =
  | 'name-missing'
  | 'name-too-long'
  | 'muscle-missing'
  | 'steps-invalid'
  | 'equipment-invalid'
  | 'type-invalid';

/** Os passos digitados: uma linha cada, sem linhas em branco e sem espaços nas pontas. */
export function parseSteps(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Confere o formulário. Lista vazia = pode salvar. */
export function validateExerciseForm(form: ExerciseForm): ExerciseFormIssue[] {
  const issues: ExerciseFormIssue[] = [];
  const name = form.name.trim();
  if (name === '') issues.push('name-missing');
  else if (name.length > EXERCISE_LIMITS.nameMax) issues.push('name-too-long');
  if (!isMuscleId(form.muscle)) issues.push('muscle-missing');
  if (!(EQUIPMENT_IDS as readonly string[]).includes(form.equipment))
    issues.push('equipment-invalid');
  if (!(RECORD_TYPES as readonly string[]).includes(form.recordType)) issues.push('type-invalid');
  const steps = parseSteps(form.steps);
  if (
    steps.length > EXERCISE_LIMITS.stepsMax ||
    steps.some((step) => step.length > EXERCISE_LIMITS.stepMax)
  ) {
    issues.push('steps-invalid');
  }
  return issues;
}

/** O formulário mudou desde que foi aberto? Espaço nas pontas do nome e linhas em branco não contam como mudança. */
export function isFormDirty(initial: ExerciseForm, current: ExerciseForm): boolean {
  const normal = (form: ExerciseForm) =>
    JSON.stringify([
      form.name.trim(),
      form.muscle,
      form.equipment,
      form.recordType,
      parseSteps(form.steps),
    ]);
  return normal(initial) !== normal(current);
}

/** Dois nomes são "o mesmo" para o aviso de repetido quando só diferem de acento, caixa ou pontuação. */
export function sameExerciseName(a: string, b: string): boolean {
  const left = normalizeText(a);
  return left !== '' && left === normalizeText(b);
}
