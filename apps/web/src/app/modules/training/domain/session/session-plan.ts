import type { RoutineItemModel } from '../routines/routine-model';
import { isWorkingSet } from './session-model';

/**
 * O plano da sessão: o que falta fazer da rotina, em ordem, respeitando superséries. Funções puras: a tela passa a
 * rotina e as séries já feitas, e recebe o próximo alvo.
 */

/** O que o plano precisa saber de uma série feita (a linha local serve). */
export interface PlanSet {
  readonly exerciseId: string;
  readonly setType: string;
}

/** Próxima série a fazer. */
export interface PlanTarget {
  readonly exerciseId: string;
  /** Item da rotina de onde veio o alvo. */
  readonly itemId: string;
  /** Número da série (1 a `targetSets`). */
  readonly setNumber: number;
  readonly targetSets: number;
  readonly repMin: number;
  readonly repMax: number;
  /** Descanso, em segundos, do item; só vale quando `rest` é verdadeiro (numa supersérie, o do último item da rodada). */
  readonly restSeconds: number;
  /**
   * O descanso vem depois desta série? Não vem no meio de uma supersérie (A1, B1, descanso, A2, B2, descanso...) e
   * não vem depois da última série do treino (não sobra nada para descansar).
   */
  readonly rest: boolean;
  readonly supersetGroup: number | null;
}

/** Uma linha do andamento: item da rotina ou exercício feito fora dela. */
export interface PlanEntry {
  readonly exerciseId: string;
  /** `null` no exercício extra (fora da rotina). */
  readonly itemId: string | null;
  /** `null` no exercício extra: não tem meta. */
  readonly targetSets: number | null;
  /** Séries de trabalho já feitas (aquecimento não conta). */
  readonly doneSets: number;
  readonly skipped: boolean;
  readonly extra: boolean;
}

export interface PlanProgress {
  readonly entries: readonly PlanEntry[];
  readonly next: PlanTarget | null;
}

interface Slot {
  readonly item: RoutineItemModel;
  readonly round: number;
  readonly block: number;
  readonly superset: boolean;
}

/**
 * Blocos da rotina: itens vizinhos com o mesmo `supersetGroup` formam um bloco de supersérie; os demais são blocos de um
 * item só.
 */
function blocksOf(items: readonly RoutineItemModel[]): RoutineItemModel[][] {
  const blocks: RoutineItemModel[][] = [];
  for (const item of items) {
    const last = blocks[blocks.length - 1];
    if (last && item.supersetGroup !== null && last[0].supersetGroup === item.supersetGroup) {
      last.push(item);
    } else {
      blocks.push([item]);
    }
  }
  return blocks;
}

/** Todas as séries da rotina na ordem em que se fazem: por bloco, por rodada, e dentro da rodada item a item. */
function scheduleOf(items: readonly RoutineItemModel[]): Slot[] {
  const slots: Slot[] = [];
  blocksOf(items).forEach((block, blockIndex) => {
    const rounds = Math.max(...block.map((item) => item.targetSets));
    for (let round = 1; round <= rounds; round++) {
      for (const item of block) {
        if (item.targetSets >= round) {
          slots.push({ item, round, block: blockIndex, superset: block.length > 1 });
        }
      }
    }
  });
  return slots;
}

/**
 * O andamento da sessão e o próximo alvo.
 *
 * - O alvo é a primeira série da rotina que ainda não foi feita, na ordem da supersérie (A1, B1, A2, B2...).
 * - Série **de aquecimento não conta**: só as de trabalho (qualquer tipo menos aquecimento) abatem a meta.
 * - Exercício **pulado** (`skipped`) sai do plano; a série dele que já foi feita continua feita.
 * - Exercício feito **fora da rotina** (substituído ou acrescentado) aparece como linha extra, sem meta, e nunca é alvo.
 * - Se o mesmo exercício aparece em dois itens da rotina, as séries feitas abatem o primeiro item e depois o segundo.
 */
export function planProgress(
  routineItems: readonly RoutineItemModel[],
  sets: readonly PlanSet[],
  skipped: readonly string[] = [],
): PlanProgress {
  const ordered = [...routineItems].sort((a, b) => a.position - b.position);
  const skippedIds = new Set(skipped);

  const doneByExercise = new Map<string, number>();
  const exerciseOrder: string[] = [];
  for (const set of sets) {
    if (!exerciseOrder.includes(set.exerciseId)) exerciseOrder.push(set.exerciseId);
    if (isWorkingSet(set.setType)) {
      doneByExercise.set(set.exerciseId, (doneByExercise.get(set.exerciseId) ?? 0) + 1);
    }
  }

  // As séries feitas de um exercício abatem os itens dele na ordem da rotina.
  const left = new Map(doneByExercise);
  const doneByItem = new Map<string, number>();
  for (const item of ordered) {
    const available = left.get(item.exerciseId) ?? 0;
    const used = Math.min(available, item.targetSets);
    doneByItem.set(item.id, used);
    left.set(item.exerciseId, available - used);
  }

  const entries: PlanEntry[] = ordered.map((item) => ({
    exerciseId: item.exerciseId,
    itemId: item.id,
    targetSets: item.targetSets,
    doneSets: doneByItem.get(item.id) ?? 0,
    skipped: skippedIds.has(item.exerciseId),
    extra: false,
  }));
  const inRoutine = new Set(ordered.map((item) => item.exerciseId));
  for (const exerciseId of exerciseOrder) {
    if (inRoutine.has(exerciseId)) continue;
    entries.push({
      exerciseId,
      itemId: null,
      targetSets: null,
      doneSets: doneByExercise.get(exerciseId) ?? 0,
      skipped: false,
      extra: true,
    });
  }

  // O que ainda falta, na ordem; o pulo tira o exercício todo do plano.
  const remaining = scheduleOf(ordered).filter(
    (slot) =>
      !skippedIds.has(slot.item.exerciseId) && slot.round > (doneByItem.get(slot.item.id) ?? 0),
  );
  const first = remaining[0];
  if (first === undefined) return { entries, next: null };

  const following = remaining[1];
  const midSuperset =
    following !== undefined &&
    first.superset &&
    following.block === first.block &&
    following.round === first.round;
  return {
    entries,
    next: {
      exerciseId: first.item.exerciseId,
      itemId: first.item.id,
      setNumber: first.round,
      targetSets: first.item.targetSets,
      repMin: first.item.repMin,
      repMax: first.item.repMax,
      restSeconds: first.item.restSeconds,
      rest: following !== undefined && !midSuperset,
      supersetGroup: first.item.supersetGroup,
    },
  };
}

/** Atalho: só o próximo alvo (ver `planProgress`). `null` quando a rotina acabou. */
export function nextTarget(
  routineItems: readonly RoutineItemModel[],
  sets: readonly PlanSet[],
  skipped: readonly string[] = [],
): PlanTarget | null {
  return planProgress(routineItems, sets, skipped).next;
}

/** Série de uma sessão anterior, como serve para pré-preencher. */
export interface PriorSet {
  readonly weightKg: number | null;
  readonly reps: number | null;
  readonly durationS: number | null;
}

/**
 * "A mesma série da última vez": a série de mesmo número da vez anterior (carga e repetições), ou a última dela se esta
 * vez já passou do que a anterior teve. `null` se não há histórico. `prior` vem em ordem de execução.
 */
export function prefillFor(prior: readonly PriorSet[], setNumber: number): PriorSet | null {
  if (prior.length === 0) return null;
  const index = Math.min(Math.max(setNumber, 1), prior.length) - 1;
  const { weightKg, reps, durationS } = prior[index];
  return { weightKg, reps, durationS };
}

/** O que o resumo precisa saber de um exercício. */
export interface SummaryExercise {
  readonly recordType: string;
  readonly equipment: string;
}

export interface SummarySet {
  readonly exerciseId: string;
  readonly setType: string;
  readonly weightKg: number | null;
  readonly reps: number | null;
}

export interface ExerciseSummary {
  readonly exerciseId: string;
  readonly workingSets: number;
  readonly volumeKg: number;
}

export interface SessionSummary {
  /** Séries de trabalho (aquecimento não entra). */
  readonly workingSets: number;
  readonly warmupSets: number;
  /** Σ carga × repetições das séries de trabalho. Nos halteres vale a carga de **um** halter (não se dobra). */
  readonly volumeKg: number;
  /** Duração em ms; `null` enquanto o treino está aberto. */
  readonly durationMs: number | null;
  readonly exercises: readonly ExerciseSummary[];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Resumo ao terminar. Aquecimento não entra no volume nem na contagem de séries de trabalho. O volume só soma série com
 * carga e repetições, de exercício de carga e repetições (ou de exercício que o aparelho não conhece, mas tem os dois
 * valores). Halteres contam a carga de um halter, como o mock: a conta é a mesma de qualquer outro equipamento.
 */
export function sessionSummary(
  sets: readonly SummarySet[],
  exercises: ReadonlyMap<string, SummaryExercise>,
  session: { readonly startedAt: number; readonly finishedAt: number | null },
): SessionSummary {
  let workingSets = 0;
  let warmupSets = 0;
  let volume = 0;
  const byExercise = new Map<string, { workingSets: number; volumeKg: number }>();

  for (const set of sets) {
    if (!isWorkingSet(set.setType)) {
      warmupSets++;
      continue;
    }
    workingSets++;
    const entry = byExercise.get(set.exerciseId) ?? { workingSets: 0, volumeKg: 0 };
    entry.workingSets++;
    const recordType = exercises.get(set.exerciseId)?.recordType;
    const countsLoad = recordType === undefined || recordType === 'weight_reps';
    if (countsLoad && set.weightKg !== null && set.reps !== null) {
      const load = set.weightKg * set.reps;
      entry.volumeKg += load;
      volume += load;
    }
    byExercise.set(set.exerciseId, entry);
  }

  return {
    workingSets,
    warmupSets,
    volumeKg: round2(volume),
    durationMs: session.finishedAt === null ? null : session.finishedAt - session.startedAt,
    exercises: [...byExercise].map(([exerciseId, entry]) => ({
      exerciseId,
      workingSets: entry.workingSets,
      volumeKg: round2(entry.volumeKg),
    })),
  };
}
