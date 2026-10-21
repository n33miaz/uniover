import { type LiveRecords, detectLiveRecords, personalRecords } from '../domain/progress/records';
import type { ProgressSet } from '../domain/progress/series';

/**
 * Recordes do treino de hoje, vistos pela tela. As regras (o que é recorde, 1RM por Epley, "só com histórico anterior")
 * são do domínio; aqui só se junta o que a tela precisa: qual série bateu o quê, e o que o treino inteiro bateu.
 */

/** Uma série do treino de hoje, com o que a conta precisa (o `id` da linha e a ordem em que foi feita). */
export interface SessionSet extends ProgressSet {
  readonly id: string;
  readonly exerciseId: string;
  readonly position: number;
}

function chronological<T extends SessionSet>(sets: readonly T[]): T[] {
  return [...sets].sort((a, b) => a.completedAt - b.completedAt || a.position - b.position);
}

/**
 * Para cada série de hoje que bateu um recorde, o que ela bateu e o valor de antes. A série é comparada com o histórico
 * anterior ao treino **e** com as séries que a precederam no próprio treino: a segunda série com a mesma carga não repete
 * o aviso da primeira. Série que não bateu nada não entra no mapa.
 */
export function recordsBySet(
  past: ReadonlyMap<string, readonly ProgressSet[]>,
  sessionSets: readonly SessionSet[],
): Map<string, LiveRecords> {
  const flags = new Map<string, LiveRecords>();
  const history = new Map<string, ProgressSet[]>();
  for (const set of chronological(sessionSets)) {
    const before = history.get(set.exerciseId) ?? [...(past.get(set.exerciseId) ?? [])];
    const found = detectLiveRecords(before, set);
    if (found.maxWeight !== null || found.oneRepMax !== null) flags.set(set.id, found);
    before.push(set);
    history.set(set.exerciseId, before);
  }
  return flags;
}

/** Um recorde batido no treino, para a lista do resumo. */
export interface SessionRecord {
  readonly exerciseId: string;
  readonly kind: 'maxWeight' | 'oneRepMax';
  /** O valor de antes, em kg. */
  readonly previousKg: number;
  /** O valor novo, em kg (para o 1RM, a estimativa). */
  readonly valueKg: number;
  /** Repetições da série que bateu o recorde. */
  readonly reps: number;
}

/**
 * O que o treino inteiro bateu, por exercício: carga máxima e 1RM estimado, comparados com o melhor de todo o histórico
 * anterior ao treino. Exercício sem histórico anterior de carga não tem recorde (a primeira vez não conta).
 */
export function sessionRecords(
  past: ReadonlyMap<string, readonly ProgressSet[]>,
  sessionSets: readonly SessionSet[],
): SessionRecord[] {
  const byExercise = new Map<string, SessionSet[]>();
  for (const set of sessionSets) {
    byExercise.set(set.exerciseId, [...(byExercise.get(set.exerciseId) ?? []), set]);
  }

  const records: SessionRecord[] = [];
  for (const [exerciseId, sets] of byExercise) {
    const before = personalRecords(past.get(exerciseId) ?? []);
    if (before.maxWeight === null) continue;
    const today = personalRecords(sets);

    if (today.maxWeight !== null && today.maxWeight.weightKg > before.maxWeight.weightKg) {
      records.push({
        exerciseId,
        kind: 'maxWeight',
        previousKg: before.maxWeight.weightKg,
        valueKg: today.maxWeight.weightKg,
        reps: today.maxWeight.reps,
      });
    }
    if (
      today.oneRepMax !== null &&
      before.oneRepMax !== null &&
      today.oneRepMax.valueKg > before.oneRepMax.valueKg
    ) {
      records.push({
        exerciseId,
        kind: 'oneRepMax',
        previousKg: before.oneRepMax.valueKg,
        valueKg: today.oneRepMax.valueKg,
        reps: today.oneRepMax.reps,
      });
    }
  }
  return records;
}
