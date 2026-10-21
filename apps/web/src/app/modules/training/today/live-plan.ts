import { NEW_ITEM_DEFAULTS, type RoutineItemModel } from '../domain/routines/routine-model';
import { DEFAULT_REST_SECONDS } from '../domain/session/rest-timer';
import { isWorkingSet } from '../domain/session/session-model';
import { planProgress } from '../domain/session/session-plan';

/**
 * O treino ao vivo visto pela tela: as linhas do plano e a série em foco. Funções puras sobre o plano da sessão
 * (`planProgress`), que cuida da ordem, das superséries e do que já foi feito.
 *
 * Trocar um exercício só por hoje não mexe na rotina: o item da rotina passa a ser feito com outro exercício. Para o
 * plano (número da série, descanso, supersérie) nada muda, então antes de perguntar ao plano as séries do substituto
 * são contadas como do original; para a tela e para gravar vale o exercício que de fato se faz.
 */

export interface LiveSetInput {
  readonly exerciseId: string;
  readonly setType: string;
}

/** Uma linha do plano: item da rotina (inclusive o trocado ou pulado) ou exercício feito fora dela. */
export interface LiveEntry {
  /** `item:<id do item>` ou `extra:<id do exercício>`: serve para escolher a linha como foco. */
  readonly key: string;
  readonly itemId: string | null;
  /** O exercício que a rotina prevê (o original, mesmo trocado). */
  readonly planExerciseId: string;
  /** O exercício que se faz de fato (o substituto, se houve troca). */
  readonly exerciseId: string;
  /** Séries de trabalho já feitas (aquecimento não conta). */
  readonly doneSets: number;
  /** `null` no exercício fora da rotina: não tem meta. */
  readonly targetSets: number | null;
  readonly skipped: boolean;
  readonly extra: boolean;
  readonly swapped: boolean;
}

/** A série que a tela mostra agora. */
export interface LiveFocus {
  readonly key: string;
  readonly itemId: string | null;
  readonly planExerciseId: string;
  readonly exerciseId: string;
  /** Número da série; passa da meta quando é uma série a mais. */
  readonly setNumber: number;
  readonly targetSets: number | null;
  readonly repMin: number;
  readonly repMax: number;
  readonly restSeconds: number;
  /** O descanso vem depois desta série? Não vem no meio de uma supersérie nem depois da última do plano. */
  readonly rest: boolean;
  readonly supersetGroup: number | null;
  /** Série além da meta, ou exercício fora da rotina. */
  readonly extra: boolean;
  readonly swapped: boolean;
  /** Posição do exercício na rotina (a partir de 1); `null` fora da rotina. */
  readonly position: number | null;
  /** Quantos exercícios a rotina tem (0 no treino livre). */
  readonly total: number;
  /** A pessoa escolheu este exercício (em vez de seguir o plano). */
  readonly chosen: boolean;
}

export interface LivePlan {
  readonly entries: readonly LiveEntry[];
  /** `null` quando não há o que fazer agora: plano concluído, ou treino livre sem exercício escolhido. */
  readonly focus: LiveFocus | null;
  /** A rotina tem exercícios e todas as séries previstas estão feitas ou puladas. */
  readonly planDone: boolean;
}

export interface LivePlanInput {
  readonly items: readonly RoutineItemModel[];
  /** As séries feitas, em ordem de execução. */
  readonly sets: readonly LiveSetInput[];
  /** Exercícios da rotina que a pessoa pulou (o id do exercício previsto, não o do substituto). */
  readonly skipped: readonly string[];
  /** Item da rotina → exercício que o substitui hoje. */
  readonly swaps: ReadonlyMap<string, string>;
  /** Linha escolhida pela pessoa (`LiveEntry.key`), ou `null` para seguir o plano. */
  readonly chosen: string | null;
}

export const itemKey = (itemId: string) => `item:${itemId}`;
export const extraKey = (exerciseId: string) => `extra:${exerciseId}`;

export function buildLivePlan(input: LivePlanInput): LivePlan {
  const ordered = [...input.items].sort((a, b) => a.position - b.position);
  const swapOf = (item: RoutineItemModel) => input.swaps.get(item.id) ?? item.exerciseId;

  // Séries do substituto contam como do exercício previsto: o plano só conhece o previsto.
  const substituteOf = new Map<string, string>();
  for (const item of ordered) {
    const substitute = input.swaps.get(item.id);
    if (substitute !== undefined && substitute !== item.exerciseId) {
      substituteOf.set(substitute, item.exerciseId);
    }
  }
  const planSets = input.sets.map((set) => ({
    exerciseId: substituteOf.get(set.exerciseId) ?? set.exerciseId,
    setType: set.setType,
  }));

  const progress = planProgress(ordered, planSets, input.skipped);
  const itemsById = new Map(ordered.map((item) => [item.id, item]));

  const entries: LiveEntry[] = progress.entries.map((entry) => {
    const item = entry.itemId === null ? undefined : itemsById.get(entry.itemId);
    const exerciseId = item ? swapOf(item) : entry.exerciseId;
    return {
      key: item ? itemKey(item.id) : extraKey(entry.exerciseId),
      itemId: item?.id ?? null,
      planExerciseId: entry.exerciseId,
      exerciseId,
      doneSets: entry.doneSets,
      targetSets: entry.targetSets,
      skipped: entry.skipped,
      extra: entry.extra,
      swapped: exerciseId !== entry.exerciseId,
    };
  });

  // Exercício escolhido que ainda não tem série (acabou de ser acrescentado): aparece na lista mesmo assim.
  const chosenKey = input.chosen;
  if (chosenKey?.startsWith('extra:') && !entries.some((entry) => entry.key === chosenKey)) {
    const exerciseId = chosenKey.slice('extra:'.length);
    entries.push({
      key: chosenKey,
      itemId: null,
      planExerciseId: exerciseId,
      exerciseId,
      doneSets: 0,
      targetSets: null,
      skipped: false,
      extra: true,
      swapped: false,
    });
  }

  const workDone = (exerciseId: string) =>
    planSets.filter((set) => set.exerciseId === exerciseId && isWorkingSet(set.setType)).length;

  const focusOfEntry = (entry: LiveEntry, chosen: boolean): LiveFocus => {
    const item = entry.itemId === null ? undefined : itemsById.get(entry.itemId);
    if (!item) {
      return {
        key: entry.key,
        itemId: null,
        planExerciseId: entry.planExerciseId,
        exerciseId: entry.exerciseId,
        setNumber: entry.doneSets + 1,
        targetSets: null,
        repMin: NEW_ITEM_DEFAULTS.repMin,
        repMax: NEW_ITEM_DEFAULTS.repMax,
        restSeconds: DEFAULT_REST_SECONDS,
        rest: true,
        supersetGroup: null,
        extra: true,
        swapped: false,
        position: null,
        total: ordered.length,
        chosen,
      };
    }
    const beyond = entry.doneSets >= item.targetSets;
    return {
      key: entry.key,
      itemId: item.id,
      planExerciseId: entry.planExerciseId,
      exerciseId: entry.exerciseId,
      setNumber: beyond ? workDone(item.exerciseId) + 1 : entry.doneSets + 1,
      targetSets: item.targetSets,
      repMin: item.repMin,
      repMax: item.repMax,
      restSeconds: item.restSeconds,
      rest: true,
      supersetGroup: item.supersetGroup,
      extra: beyond,
      swapped: entry.swapped,
      position: ordered.indexOf(item) + 1,
      total: ordered.length,
      chosen,
    };
  };

  let focus: LiveFocus | null = null;
  const chosenEntry = chosenKey === null ? undefined : entries.find((e) => e.key === chosenKey);
  if (chosenEntry) {
    focus = focusOfEntry(chosenEntry, true);
  } else if (progress.next) {
    const next = progress.next;
    const item = itemsById.get(next.itemId);
    const entry = entries.find((e) => e.itemId === next.itemId);
    if (item && entry) {
      focus = {
        key: entry.key,
        itemId: item.id,
        planExerciseId: next.exerciseId,
        exerciseId: swapOf(item),
        setNumber: next.setNumber,
        targetSets: next.targetSets,
        repMin: next.repMin,
        repMax: next.repMax,
        restSeconds: next.restSeconds,
        rest: next.rest,
        supersetGroup: next.supersetGroup,
        extra: false,
        swapped: entry.swapped,
        position: ordered.indexOf(item) + 1,
        total: ordered.length,
        chosen: false,
      };
    }
  } else if (ordered.length === 0 && input.sets.length > 0) {
    // Treino livre: segue no exercício da última série, até a pessoa escolher outro.
    const last = input.sets[input.sets.length - 1].exerciseId;
    const entry = entries.find((e) => e.key === extraKey(last));
    if (entry) focus = focusOfEntry(entry, false);
  }

  return { entries, focus, planDone: ordered.length > 0 && focus === null };
}
