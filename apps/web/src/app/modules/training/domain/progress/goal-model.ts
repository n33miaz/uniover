/**
 * Modelo e limites das metas do dono. Tipos e funções puras: nada de Angular, banco ou rede. Os limites são os mesmos da
 * API, para o que ela recusaria nem entrar na fila de escrita. A meta é do dono: o app só mostra a distância até ela.
 */

/** Os tipos de meta, com os mesmos valores da API. */
export const GOAL_KINDS = ['exercise_e1rm', 'weekly_sessions', 'daily_kcal'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

/** Faixa de valores aceita por tipo de meta (limites incluídos). */
export const GOAL_LIMITS: Readonly<
  Record<GoalKind, { readonly min: number; readonly max: number }>
> = {
  exercise_e1rm: { min: 1, max: 1000 },
  weekly_sessions: { min: 1, max: 14 },
  daily_kcal: { min: 500, max: 10000 },
};

export const isGoalKind = (value: string): value is GoalKind =>
  (GOAL_KINDS as readonly string[]).includes(value);

/** Só a meta de 1RM é por exercício; as demais valem para a pessoa toda. */
export function goalRequiresExercise(kind: GoalKind): boolean {
  return kind === 'exercise_e1rm';
}

/**
 * Chave natural da meta: tipo e exercício. É o id da linha no aparelho (o servidor também acha a meta por ela), então o
 * mesmo pedido repetido nunca duplica.
 */
export function goalKey(kind: GoalKind, exerciseId: string | null): string {
  return `${kind}:${exerciseId ?? ''}`;
}

/** O que está errado numa meta, sem texto: a tela escolhe a mensagem (i18n). */
export type GoalIssueCode =
  'value-range' | 'value-decimals' | 'exercise-required' | 'exercise-not-allowed';

export interface GoalIssue {
  readonly path: 'value' | 'exerciseId';
  readonly code: GoalIssueCode;
}

/** Confere a meta com os mesmos limites da API. Lista vazia = pode gravar. */
export function validateGoal(
  kind: GoalKind,
  value: number,
  exerciseId: string | null,
): GoalIssue[] {
  const issues: GoalIssue[] = [];
  const { min, max } = GOAL_LIMITS[kind];

  if (!Number.isFinite(value) || value < min || value > max) {
    issues.push({ path: 'value', code: 'value-range' });
  } else if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    issues.push({ path: 'value', code: 'value-decimals' });
  }

  if (goalRequiresExercise(kind)) {
    if (exerciseId === null || exerciseId === '') {
      issues.push({ path: 'exerciseId', code: 'exercise-required' });
    }
  } else if (exerciseId !== null) {
    issues.push({ path: 'exerciseId', code: 'exercise-not-allowed' });
  }
  return issues;
}

/** A distância até a meta: quanto falta (positivo) ou quanto passou (negativo), e se já foi alcançada. */
export function distanceToGoal(
  current: number,
  goal: number,
): { remaining: number; reached: boolean } {
  return { remaining: goal - current, reached: current >= goal };
}
