import { type PlanRoutine, routinesOnWeekday } from '../routines/week-plan';

/** Estado de um dia no calendário pessoal de treinos. */
export type TrainingDayState = 'done' | 'today' | 'planned' | 'rest' | 'absent' | 'empty';

/**
 * Uma semana lida para o ritmo: treinos feitos, meta e a ausência já medida contra os dias de treino. `absentDays` são os
 * dias ausentes que contam (os de treino do programa; sem programa, todos) e `availableDays` os dias em que a meta cabe.
 */
export interface WeekRhythm {
  readonly completed: number;
  readonly goal: number;
  readonly absentDays: number;
  readonly availableDays?: number;
  /** A semana ainda corre: se a meta não foi batida, ela não quebra a sequência, só não soma. */
  readonly open?: boolean;
}

const DAYS_IN_WEEK = 7;

/**
 * A meta da semana depois das ausências planejadas. Cada dia ausente tira a sua parte proporcional da meta (arredondada
 * para cima) entre os `availableDays` em que ela cabe: com programa, os dias de treino dele (uma viagem de fim de semana
 * num programa de segunda a sexta não muda nada); sem programa, os sete dias. Semana toda ausente não cobra nada.
 */
export function adjustedWeeklyGoal(
  goal: number,
  absentDays: number,
  availableDays: number = DAYS_IN_WEEK,
): number {
  const available = Math.min(Math.max(1, availableDays), DAYS_IN_WEEK);
  const absent = Math.min(Math.max(0, absentDays), available);
  if (absent >= available) return 0;
  return Math.ceil((goal * (available - absent)) / available);
}

/** Quantos treinos ainda faltam na semana, já com as ausências descontadas da meta. Nunca é negativo. */
export function remainingWorkouts(
  goal: number,
  completed: number,
  absentDays: number,
  availableDays: number = DAYS_IN_WEEK,
): number {
  return Math.max(0, adjustedWeeklyGoal(goal, absentDays, availableDays) - completed);
}

/**
 * Semanas seguidas com a meta cumprida, da mais recente para a mais antiga. Uma semana toda ausente é neutra (não soma e
 * não quebra); uma semana ainda aberta e incompleta também não quebra. A primeira semana fechada abaixo da meta encerra.
 */
export function weeklyStreak(weeks: readonly WeekRhythm[]): number {
  let streak = 0;
  for (const week of weeks) {
    const goal = adjustedWeeklyGoal(week.goal, week.absentDays, week.availableDays);
    if (goal === 0) continue;
    if (week.completed >= goal) streak++;
    else if (!week.open) break;
  }
  return streak;
}

/**
 * Meta padrão do programa ativo: quantos dias da semana ele treina. `null` sem programa ou sem fichas dele.
 * Mesma regra de dias da ficha de hoje (ficha sem dia declarado vale segunda a sexta).
 */
export function programWeeklyGoal(
  routines: readonly PlanRoutine[],
  activeProgramId: string | null,
): number | null {
  if (activeProgramId === null) return null;
  let days = 0;
  for (let weekday = 1; weekday <= DAYS_IN_WEEK; weekday++) {
    if (routinesOnWeekday(routines, weekday, activeProgramId).length > 0) days++;
  }
  return days === 0 ? null : days;
}
