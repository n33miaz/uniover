import {
  DEFAULT_ONE_RM_FORMULA,
  type OneRmFormula,
  estimateSet1RM,
  isLoadSet,
} from './one-rep-max';
import type { ProgressSet } from './series';

/** Quantas sessões recentes definem a "carga de referência" do recorde de repetições. */
export const REFERENCE_SESSIONS = 4;

/** Tolerância para comparar quilos com ponto decimal (nenhuma carga real tem diferença menor). */
const EPSILON = 1e-9;

export interface MaxWeightRecord {
  readonly weightKg: number;
  readonly reps: number;
  readonly completedAt: number;
  readonly sessionId: string;
}

export interface OneRepMaxRecord {
  readonly valueKg: number;
  /** A série que gerou a estimativa. */
  readonly weightKg: number;
  readonly reps: number;
  readonly completedAt: number;
  readonly sessionId: string;
}

export interface SessionVolumeRecord {
  readonly volumeKg: number;
  readonly sessionId: string;
  /** Instante da última série da sessão. */
  readonly completedAt: number;
  /** Quantas séries (sem aquecimento) somaram o volume. */
  readonly sets: number;
}

export interface MaxRepsRecord {
  /** A carga de referência: a mais usada nas últimas quatro sessões do exercício. */
  readonly weightKg: number;
  readonly reps: number;
  readonly completedAt: number;
  readonly sessionId: string;
}

export interface PersonalRecords {
  readonly maxWeight: MaxWeightRecord | null;
  readonly oneRepMax: OneRepMaxRecord | null;
  readonly maxSessionVolume: SessionVolumeRecord | null;
  readonly maxRepsAtLoad: MaxRepsRecord | null;
}

/** Série a mais ou igual a um instante, em ordem do mais antigo para o mais novo (empate fica com a primeira). */
function chronological(sets: readonly ProgressSet[]): ProgressSet[] {
  return [...sets].sort((a, b) => a.completedAt - b.completedAt);
}

function hundredths(kg: number): number {
  return Math.round(kg * 100);
}

/**
 * Os recordes de um exercício, calculados das séries (nada é guardado: tudo se recalcula).
 *
 * - **Carga máxima**: a maior carga em série de trabalho ou falha, com as repetições; empate fica com mais repetições e,
 *   se ainda empatar, com a que veio primeiro (quem bate o recorde primeiro o segura).
 * - **1RM estimado**: a melhor estimativa (só séries de 1 a 10 repetições), pela fórmula pedida.
 * - **Maior volume numa sessão**: Σ carga × repetições das séries da sessão, sem aquecimento.
 * - **Mais repetições numa carga**: a carga de referência é a **mais usada nas últimas quatro sessões** do exercício (a
 *   que tem mais séries de trabalho ou falha; empate fica com a mais pesada); o recorde é o máximo de repetições feitas
 *   exatamente com ela em todo o histórico. É escolha nossa: nenhuma fonte diz qual carga usar.
 */
export function personalRecords(
  sets: readonly ProgressSet[],
  formula: OneRmFormula = DEFAULT_ONE_RM_FORMULA,
): PersonalRecords {
  const ordered = chronological(sets);
  const loadSets = ordered.filter(isLoadSet);

  let maxWeight: MaxWeightRecord | null = null;
  let oneRepMax: OneRepMaxRecord | null = null;
  for (const set of loadSets) {
    const weightKg = set.weightKg as number;
    const reps = set.reps as number;
    if (
      maxWeight === null ||
      weightKg > maxWeight.weightKg + EPSILON ||
      (Math.abs(weightKg - maxWeight.weightKg) <= EPSILON && reps > maxWeight.reps)
    ) {
      maxWeight = { weightKg, reps, completedAt: set.completedAt, sessionId: set.sessionId };
    }
    const estimate = estimateSet1RM(set, formula);
    if (estimate !== null && (oneRepMax === null || estimate > oneRepMax.valueKg + EPSILON)) {
      oneRepMax = {
        valueKg: estimate,
        weightKg,
        reps,
        completedAt: set.completedAt,
        sessionId: set.sessionId,
      };
    }
  }

  return {
    maxWeight,
    oneRepMax,
    maxSessionVolume: maxSessionVolume(ordered),
    maxRepsAtLoad: maxRepsAtReferenceLoad(loadSets),
  };
}

function maxSessionVolume(ordered: readonly ProgressSet[]): SessionVolumeRecord | null {
  const bySession = new Map<string, { volume: number; sets: number; last: number }>();
  for (const set of ordered) {
    if (set.setType === 'warmup') continue;
    if (set.weightKg === null || set.reps === null || set.weightKg <= 0 || set.reps <= 0) continue;
    const entry = bySession.get(set.sessionId) ?? { volume: 0, sets: 0, last: 0 };
    entry.volume += set.weightKg * set.reps;
    entry.sets++;
    entry.last = Math.max(entry.last, set.completedAt);
    bySession.set(set.sessionId, entry);
  }

  let best: SessionVolumeRecord | null = null;
  for (const [sessionId, entry] of bySession) {
    const volumeKg = Math.round(entry.volume * 100) / 100;
    if (best === null || volumeKg > best.volumeKg + EPSILON) {
      best = { volumeKg, sessionId, completedAt: entry.last, sets: entry.sets };
    } else if (Math.abs(volumeKg - best.volumeKg) <= EPSILON && entry.last < best.completedAt) {
      best = { volumeKg, sessionId, completedAt: entry.last, sets: entry.sets };
    }
  }
  return best;
}

/** A carga de referência do exercício (ver `personalRecords`), ou `null` sem histórico de carga. */
export function referenceLoadKg(loadSets: readonly ProgressSet[]): number | null {
  const lastActivity = new Map<string, number>();
  for (const set of loadSets) {
    lastActivity.set(
      set.sessionId,
      Math.max(lastActivity.get(set.sessionId) ?? 0, set.completedAt),
    );
  }
  const recent = new Set(
    [...lastActivity]
      .sort((a, b) => b[1] - a[1])
      .slice(0, REFERENCE_SESSIONS)
      .map(([sessionId]) => sessionId),
  );

  const uses = new Map<number, number>();
  for (const set of loadSets) {
    if (!recent.has(set.sessionId)) continue;
    const key = hundredths(set.weightKg as number);
    uses.set(key, (uses.get(key) ?? 0) + 1);
  }
  let best: { key: number; count: number } | null = null;
  for (const [key, count] of uses) {
    if (best === null || count > best.count || (count === best.count && key > best.key)) {
      best = { key, count };
    }
  }
  return best === null ? null : best.key / 100;
}

function maxRepsAtReferenceLoad(loadSets: readonly ProgressSet[]): MaxRepsRecord | null {
  const reference = referenceLoadKg(loadSets);
  if (reference === null) return null;

  let best: MaxRepsRecord | null = null;
  for (const set of loadSets) {
    if (hundredths(set.weightKg as number) !== hundredths(reference)) continue;
    const reps = set.reps as number;
    if (best === null || reps > best.reps) {
      best = { weightKg: reference, reps, completedAt: set.completedAt, sessionId: set.sessionId };
    }
  }
  return best;
}

/** O que a série nova bateu ao vivo, com o valor anterior para a tela mostrar "de X para Y". */
export interface LiveRecords {
  readonly maxWeight: { readonly previousKg: number; readonly weightKg: number } | null;
  readonly oneRepMax: { readonly previousKg: number; readonly valueKg: number } | null;
}

const NO_LIVE_RECORDS: LiveRecords = { maxWeight: null, oneRepMax: null };

/**
 * Aviso de recorde ao vivo: a série recém-concluída (`candidate`) bateu a carga máxima ou o 1RM estimado do
 * `history` (as séries **anteriores** do exercício neste aparelho, sem a candidata)?
 *
 * - Sem histórico de carga do exercício não há aviso (senão toda primeira série seria "recorde").
 * - Só bate quem passa **estritamente**: igualar não é recorde.
 * - Sem uma estimativa de 1RM anterior para comparar (todo o histórico em séries de mais de 10 repetições), não há
 *   aviso de 1RM.
 * - A candidata precisa ser de um tipo que conta (trabalho ou falha) e ter carga e repetições.
 */
export function detectLiveRecords(
  history: readonly ProgressSet[],
  candidate: ProgressSet,
  formula: OneRmFormula = DEFAULT_ONE_RM_FORMULA,
): LiveRecords {
  if (!isLoadSet(candidate)) return NO_LIVE_RECORDS;
  const previous = personalRecords(history, formula);
  if (previous.maxWeight === null) return NO_LIVE_RECORDS;

  const weightKg = candidate.weightKg as number;
  const maxWeight =
    weightKg > previous.maxWeight.weightKg + EPSILON
      ? { previousKg: previous.maxWeight.weightKg, weightKg }
      : null;

  const estimate = estimateSet1RM(candidate, formula);
  const oneRepMax =
    estimate !== null &&
    previous.oneRepMax !== null &&
    estimate > previous.oneRepMax.valueKg + EPSILON
      ? { previousKg: previous.oneRepMax.valueKg, valueKg: estimate }
      : null;

  return { maxWeight, oneRepMax };
}

/**
 * Os recordes de carga máxima e de 1RM batidos dentro de uma janela de tempo (`from` inclusive, `to` exclusive) em relação
 * ao que existia antes dela. Serve ao resumo da semana. Sem histórico antes da janela não há recorde (a primeira vez que
 * se faz um exercício não conta).
 */
export function recordsInWindow(
  sets: readonly ProgressSet[],
  from: number,
  to: number,
  formula: OneRmFormula = DEFAULT_ONE_RM_FORMULA,
): readonly ('maxWeight' | 'oneRepMax')[] {
  const before = personalRecords(
    sets.filter((set) => set.completedAt < from),
    formula,
  );
  if (before.maxWeight === null) return [];
  const inside = personalRecords(
    sets.filter((set) => set.completedAt >= from && set.completedAt < to),
    formula,
  );

  const kinds: ('maxWeight' | 'oneRepMax')[] = [];
  if (
    inside.maxWeight !== null &&
    inside.maxWeight.weightKg > before.maxWeight.weightKg + EPSILON
  ) {
    kinds.push('maxWeight');
  }
  if (
    inside.oneRepMax !== null &&
    before.oneRepMax !== null &&
    inside.oneRepMax.valueKg > before.oneRepMax.valueKg + EPSILON
  ) {
    kinds.push('oneRepMax');
  }
  return kinds;
}
