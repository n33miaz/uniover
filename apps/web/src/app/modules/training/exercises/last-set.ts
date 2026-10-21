import type { LocalSet } from '../data/sessions/session';
import { formatDuration, formatKg } from '../shell/format';

/**
 * O resumo curto da última vez que o exercício foi feito ("42,5 kg × 8"): a melhor série de trabalho da última sessão
 * (a mais pesada; empate fica com mais repetições). Exercício de repetições mostra só as repetições; o de tempo, a
 * duração. `null` quando não há série que sirva.
 */
export function summarizeLastSets(
  sets: readonly Pick<LocalSet, 'weightKg' | 'reps' | 'durationS'>[],
  recordType: string,
): string | null {
  if (recordType === 'time') {
    const best = Math.max(0, ...sets.map((set) => set.durationS ?? 0));
    return best > 0 ? formatDuration(best) : null;
  }
  if (recordType === 'reps_only') {
    const best = Math.max(0, ...sets.map((set) => set.reps ?? 0));
    return best > 0 ? `× ${best}` : null;
  }
  let top: { weightKg: number; reps: number } | null = null;
  for (const set of sets) {
    if (set.weightKg === null || set.reps === null || set.weightKg <= 0 || set.reps <= 0) continue;
    if (
      top === null ||
      set.weightKg > top.weightKg ||
      (set.weightKg === top.weightKg && set.reps > top.reps)
    ) {
      top = { weightKg: set.weightKg, reps: set.reps };
    }
  }
  return top === null ? null : `${formatKg(top.weightKg)} × ${top.reps}`;
}
