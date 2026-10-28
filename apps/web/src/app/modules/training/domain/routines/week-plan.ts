import { nextRoutine } from './sequence';

/** O que o programa da semana precisa saber de uma ficha; a linha do banco local serve. */
export interface PlanRoutine {
  readonly id: string;
  readonly position: number;
  readonly active: boolean;
  readonly deletedAt: number | null;
  /** Programa que criou a ficha; vazio nas fichas livres. */
  readonly programId?: string | null;
  /** Dias ISO (1=segunda ... 7=domingo) em que a ficha acontece; vazio vale segunda a sexta. */
  readonly weekdays?: readonly number[];
}

/** O que a escolha de hoje precisa saber de um treino. */
export interface PlanSession {
  readonly routineId: string | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly deletedAt: number | null;
}

/** A ficha do dia (`null` sem programa ou em dia de descanso) e se o dia é de descanso. */
export interface DayPlan {
  readonly routineId: string | null;
  readonly resting: boolean;
}

/** Dias de treino de uma ficha de programa sem dia declarado (nunca vem do seed, que declara todos): segunda a sexta. */
const WORK_WEEK = [1, 2, 3, 4, 5] as const;

/** Dia ISO da semana (1=segunda ... 7=domingo) no relógio do aparelho. */
export function isoWeekday(timestamp: number): number {
  const day = new Date(timestamp).getDay();
  return day === 0 ? 7 : day;
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * As fichas vivas e ativas do programa que acontecem num dia ISO (1=segunda ... 7=domingo), na ordem recebida.
 * Vazio, com programa escolhido, é descanso; a regra é a mesma que decide a ficha de hoje.
 */
export function routinesOnWeekday(
  routines: readonly PlanRoutine[],
  weekday: number,
  activeProgramId: string,
): PlanRoutine[] {
  return routines.filter(
    (routine) =>
      routine.active &&
      routine.deletedAt === null &&
      routine.programId === activeProgramId &&
      ((routine.weekdays?.length ?? 0) === 0 ? WORK_WEEK : routine.weekdays!).includes(weekday),
  );
}

/**
 * A ficha de hoje no programa da semana. Calculado no aparelho, com o relógio dele, então vale sem rede.
 * `activeProgramId` é a escolha gravada e sincronizada da conta (nunca inferida das fichas).
 *
 * - Candidatas: as fichas vivas e ativas do programa escolhido cujo dia inclui hoje.
 * - Uma candidata: é a de hoje (divisão seg–sex, full-body seg/qua/sex).
 * - Várias candidatas: alternam pela sequência (A/B nos dias de treino, seg–sex). Quem já treinou uma delas hoje
 *   continua vendo a mesma até a virada do dia; amanhã vem a seguinte. O treino conta no dia em que COMEÇOU (um
 *   treino de 23h50 às 00h10 é do dia anterior).
 * - Nenhuma candidata: descanso (sábado e domingo, ou terça e quinta no full-body).
 * - Sem programa escolhido (ou sem ficha dele ainda neste aparelho): não decide nada, a tela segue a sequência.
 */
export function planForDay(
  routines: readonly PlanRoutine[],
  sessions: readonly PlanSession[],
  now: number,
  activeProgramId: string | null,
): DayPlan {
  if (activeProgramId === null) return { routineId: null, resting: false };
  const program = routines.filter(
    (routine) =>
      routine.active && routine.deletedAt === null && routine.programId === activeProgramId,
  );
  if (program.length === 0) return { routineId: null, resting: false };

  const day = isoWeekday(now);
  const candidates = routinesOnWeekday(routines, day, activeProgramId);
  if (candidates.length === 0) return { routineId: null, resting: true };
  if (candidates.length === 1) return { routineId: candidates[0].id, resting: false };

  const candidateIds = new Set(candidates.map((routine) => routine.id));
  const programIds = new Set(
    routines
      .filter((routine) => routine.programId === activeProgramId)
      .map((routine) => routine.id),
  );
  const finished = sessions
    .filter((session) => session.finishedAt !== null && session.deletedAt === null)
    .sort((a, b) => b.startedAt - a.startedAt);

  const dayStart = startOfLocalDay(now);
  const today = finished.find(
    (session) =>
      session.routineId !== null &&
      candidateIds.has(session.routineId) &&
      startOfLocalDay(session.startedAt) === dayStart,
  );
  if (today?.routineId) return { routineId: today.routineId, resting: false };

  const last = finished.find(
    (session) => session.routineId !== null && programIds.has(session.routineId),
  );
  return { routineId: nextRoutine(candidates, last?.routineId)?.id ?? null, resting: false };
}
