import { compactPositions } from './supersets';
import type { RoutineModel } from './routine-model';

/** Quantas sessões recentes entram na mediana. */
const RECENT_SESSIONS = 3;
/** Tempo de uma série, em segundos (proposta nossa, sem fonte). */
const SECONDS_PER_SET = 45;
/** Preparo de cada exercício (ajustar o aparelho, a carga, ir até ele), em segundos (proposta nossa, sem fonte). */
const SECONDS_PER_EXERCISE = 90;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Duração estimada da rotina, em minutos inteiros. É **estimativa** e a tela deve dizê-lo ("cerca de").
 *
 * - Com histórico: a mediana das três sessões mais recentes da rotina (`recentDurationsMin`, da mais nova para a mais
 *   velha; valores que não são número positivo são ignorados). Com menos de três, a mediana das que houver.
 * - Sem histórico: por exercício, séries × (45 s + descanso) + 90 s. Numa supersérie o descanso vem **uma vez por
 *   rodada** (depois do par, não depois de cada item): as rodadas são o maior número de séries do grupo e o descanso é
 *   o do último item do grupo.
 * - Rotina sem exercício: 0.
 */
export function estimateMinutes(
  routine: Pick<RoutineModel, 'items'>,
  recentDurationsMin?: readonly number[] | null,
): number {
  const durations = (recentDurationsMin ?? [])
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(0, RECENT_SESSIONS);
  if (durations.length > 0) return Math.max(1, Math.round(median(durations)));

  const items = compactPositions(routine.items);
  let seconds = 0;
  let index = 0;
  while (index < items.length) {
    // Um bloco é um item sozinho ou uma supersérie inteira (itens vizinhos com o mesmo grupo).
    const group = items[index].supersetGroup;
    let end = index + 1;
    while (group !== null && end < items.length && items[end].supersetGroup === group) end++;
    const block = items.slice(index, end);

    const rounds = Math.max(...block.map((item) => item.targetSets));
    const rest = block[block.length - 1].restSeconds;
    seconds += block.reduce(
      (sum, item) => sum + item.targetSets * SECONDS_PER_SET + SECONDS_PER_EXERCISE,
      0,
    );
    seconds += rounds * rest;
    index = end;
  }
  return seconds === 0 ? 0 : Math.max(1, Math.round(seconds / 60));
}
