import { type MuscleGroupId, MUSCLE_GROUP_IDS, muscleGroupOf } from '../taxonomy';
import {
  type MonthRange,
  addDays,
  civilDateOf,
  dateKeyOf,
  monthRange,
  startOfDay,
  weekRange,
} from './calendar';

/** O que o volume semanal precisa saber de uma série (a linha local serve). */
export interface WeekSet {
  readonly exerciseId: string;
  readonly setType: string;
  readonly completedAt: number;
}

/** O que o volume semanal precisa saber de um exercício. */
export interface WeekExercise {
  /** Músculos principais; só o primeiro conta para o volume. */
  readonly primaryMuscles: readonly string[];
}

export interface WeeklyVolume {
  /** Séries de trabalho da semana (aquecimento não conta). */
  readonly total: number;
  /** Séries por grupo muscular (os seis grupos, com zero quando nenhum). */
  readonly byGroup: Readonly<Record<MuscleGroupId, number>>;
  /** Séries por músculo principal (só os que apareceram). A tela pode separar bíceps e tríceps, que aqui são o grupo "braços". */
  readonly byMuscle: Readonly<Record<string, number>>;
  /** Séries de exercício que o aparelho não conhece ou cujo músculo não tem grupo: contam no total, em nenhum grupo. */
  readonly unclassified: number;
}

/**
 * Volume da semana: **séries de trabalho** por músculo, não quilos. Só o músculo principal do exercício (o primeiro da
 * lista) conta, e aquecimento não conta. O app mostra, não recomenda número de séries: não há norma única.
 *
 * `weekStart` é o início da semana (`weekRange(...).start`); a semana termina na segunda seguinte, no mesmo fuso.
 */
export function weeklySetsByGroup(
  sets: readonly WeekSet[],
  exercisesById: ReadonlyMap<string, WeekExercise>,
  weekStart: number,
  timeZone: string,
): WeeklyVolume {
  const { start, end } = weekRange(weekStart, timeZone);
  const byGroup = Object.fromEntries(MUSCLE_GROUP_IDS.map((id) => [id, 0])) as Record<
    MuscleGroupId,
    number
  >;
  const byMuscle: Record<string, number> = {};
  let total = 0;
  let unclassified = 0;

  for (const set of sets) {
    if (set.setType === 'warmup') continue;
    if (set.completedAt < start || set.completedAt >= end) continue;
    total++;
    const muscle = exercisesById.get(set.exerciseId)?.primaryMuscles[0];
    const group = muscle === undefined ? undefined : muscleGroupOf(muscle);
    if (muscle === undefined || group === undefined) {
      unclassified++;
      continue;
    }
    byGroup[group]++;
    byMuscle[muscle] = (byMuscle[muscle] ?? 0) + 1;
  }
  return { total, byGroup, byMuscle, unclassified };
}

/** O que o calendário e a constância precisam saber de um treino. */
export interface TrainedSession {
  readonly startedAt: number;
}

/** Dias do mês (de 1 em diante) em que houve treino, em ordem; sem repetir o dia quando houve dois treinos. */
export function trainedDays(
  sessions: readonly TrainedSession[],
  month: { readonly year: number; readonly month: number },
  timeZone: string,
): number[] {
  const range: MonthRange = monthRange(month.year, month.month, timeZone);
  const days = new Set<number>();
  for (const session of sessions) {
    if (session.startedAt < range.start || session.startedAt >= range.end) continue;
    days.add(civilDateOf(session.startedAt, timeZone).day);
  }
  return [...days].sort((a, b) => a - b);
}

export interface ConstancyWeek {
  /** Início da semana (segunda) em ms e como `AAAA-MM-DD`. */
  readonly start: number;
  readonly startKey: string;
  /** Treinos da semana. */
  readonly sessions: number;
  readonly met: boolean;
}

export interface Constancy {
  readonly goalPerWeek: number;
  /** As últimas semanas, da mais antiga para a atual (a atual está em andamento). */
  readonly weeks: readonly ConstancyWeek[];
  /**
   * Semanas seguidas com a meta cumprida, contando de trás para a frente. A semana em andamento só entra se já cumpriu a
   * meta: ela ainda não terminou e não quebra a sequência por estar incompleta.
   */
  readonly consecutiveMetWeeks: number;
}

/** Constância: quantos treinos por semana nas últimas `weeks` semanas contra a meta do dono ("o app só conta"). */
export function weeklyConstancy(
  sessions: readonly TrainedSession[],
  goalPerWeek: number,
  timeZone: string,
  now: number,
  weeks = 8,
): Constancy {
  // A segunda da semana atual, e daí para trás de sete em sete dias do calendário (nunca de 168 em 168 horas: a semana
  // que atravessa uma mudança de horário tem 167 ou 169).
  const monday = civilDateOf(weekRange(now, timeZone).start, timeZone);
  const result: ConstancyWeek[] = [];
  for (let back = weeks - 1; back >= 0; back--) {
    const weekMonday = addDays(monday, -7 * back);
    const start = startOfDay(weekMonday, timeZone);
    const end = startOfDay(addDays(weekMonday, 7), timeZone);
    const count = sessions.filter(
      (session) => session.startedAt >= start && session.startedAt < end,
    ).length;
    result.push({
      start,
      startKey: dateKeyOf(weekMonday),
      sessions: count,
      met: count >= goalPerWeek,
    });
  }

  let consecutive = 0;
  for (let index = result.length - 1; index >= 0; index--) {
    const week = result[index];
    if (week.met) consecutive++;
    else if (index === result.length - 1) continue;
    else break;
  }
  return { goalPerWeek, weeks: result, consecutiveMetWeeks: consecutive };
}
