import type { LocalExercise } from '../data/catalog/exercise';
import type { LocalSet } from '../data/sessions/session';
import type { RoutineItemModel } from '../domain/routines/routine-model';
import { isWorkingSet } from '../domain/session/session-model';
import type { LiveEntry } from './live-plan';

const DEFAULT_SET_SECONDS = 45;

/** Indica um exercício pendente cuja próxima série cabe no tempo. A ordem do plano continua disponível. */
export function recommendExercise(
  entries: readonly LiveEntry[],
  items: readonly RoutineItemModel[],
  exercises: ReadonlyMap<string, LocalExercise>,
  sets: readonly LocalSet[],
  secondsLeft: number,
): string | null {
  const exposure = new Map<string, number>();
  const duration = new Map<string, number>();
  for (const set of sets) {
    if (!isWorkingSet(set.setType)) continue;
    const exercise = exercises.get(set.exerciseId);
    if (exercise === undefined) continue;
    const primary = new Set(exercise.primaryMuscles);
    for (const muscle of primary) exposure.set(muscle, (exposure.get(muscle) ?? 0) + 1);
    for (const muscle of new Set(exercise.secondaryMuscles)) {
      if (!primary.has(muscle)) exposure.set(muscle, (exposure.get(muscle) ?? 0) + 0.5);
    }
    if (set.durationS !== null && set.durationS > 0) duration.set(set.exerciseId, set.durationS);
  }

  const itemById = new Map(items.map((item) => [item.id, item]));
  let best: { key: string; unworked: number; average: number } | undefined;
  for (const entry of entries) {
    if (entry.itemId === null || entry.skipped || entry.finished || entry.targetSets === null)
      continue;
    const remaining = entry.targetSets - entry.doneSets;
    const item = itemById.get(entry.itemId);
    const exercise = exercises.get(entry.exerciseId);
    if (remaining <= 0 || !item || !exercise || exercise.primaryMuscles.length === 0) continue;
    const estimate =
      (duration.get(entry.exerciseId) ?? DEFAULT_SET_SECONDS) +
      (remaining > 1 ? item.restSeconds : 0);
    if (estimate > secondsLeft) continue;

    const totals = [...new Set(exercise.primaryMuscles)].map((muscle) => exposure.get(muscle) ?? 0);
    const unworked = totals.filter((total) => total === 0).length;
    const average = totals.reduce((sum, total) => sum + total, 0) / totals.length;
    if (
      !best ||
      unworked > best.unworked ||
      (unworked === best.unworked && average < best.average)
    ) {
      best = { key: entry.key, unworked, average };
    }
  }
  return best?.key ?? null;
}
