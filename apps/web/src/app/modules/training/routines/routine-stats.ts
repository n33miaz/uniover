import type { LocalRoutine } from '../data/routines/routine';
import type { LocalSession } from '../data/sessions/session';
import { estimateMinutes } from '../domain/routines/estimate-minutes';
import { nextRoutine } from '../domain/routines/sequence';

/** Uma linha da lista de rotinas, já com o que a tela mostra. */
export interface RoutineEntry {
  readonly routine: LocalRoutine;
  /** A, B, C... pela ordem da sequência. */
  readonly letter: string;
  readonly exercises: number;
  readonly sets: number;
  /** Duração estimada em minutos; `null` na rotina sem exercício. */
  readonly minutes: number | null;
  /** É a rotina que a sequência sugere para o próximo treino. */
  readonly next: boolean;
}

/** Quantos treinos recentes de uma rotina entram na estimativa de duração. */
const RECENT_RUNS = 3;

function letterOf(index: number): string {
  return String.fromCharCode(65 + (index % 26));
}

/**
 * Monta as linhas da lista: A, B, C pela ordem da sequência, quantos exercícios e séries, a duração estimada (a
 * mediana dos últimos treinos da rotina, ou a conta quando ainda não há treino) e qual vem a seguir. `all` traz
 * também as rotinas apagadas e inativas, que continuam marcando de onde a sequência segue; `alive` são as que a
 * lista mostra.
 */
export function buildRoutineEntries(
  all: readonly LocalRoutine[],
  alive: readonly LocalRoutine[],
  sessions: readonly LocalSession[],
): RoutineEntry[] {
  const finished = sessions
    .filter((session) => session.finishedAt !== null && session.deletedAt === null)
    .sort((a, b) => (b.finishedAt as number) - (a.finishedAt as number));
  const lastRoutineId = finished.find((session) => session.routineId !== null)?.routineId ?? null;
  const nextId = nextRoutine(all, lastRoutineId)?.id;

  return alive.map((routine, index) => {
    const minutesOfRuns = finished
      .filter((session) => session.routineId === routine.id)
      .slice(0, RECENT_RUNS)
      .map((session) => ((session.finishedAt as number) - session.startedAt) / 60000);
    const minutes = estimateMinutes(routine, minutesOfRuns);
    return {
      routine,
      letter: letterOf(index),
      exercises: routine.items.length,
      sets: routine.items.reduce((sum, item) => sum + item.targetSets, 0),
      minutes: minutes > 0 ? minutes : null,
      next: routine.id === nextId && routine.active,
    };
  });
}
