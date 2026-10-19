/** O que a sequência precisa saber de uma rotina; a linha do banco local e o modelo do editor servem. */
export interface SequenceRoutine {
  readonly id: string;
  readonly position: number;
  readonly active: boolean;
  /** Instante em que foi apagada, ou `null` se está viva. */
  readonly deletedAt: number | null;
}

function isEligible(routine: SequenceRoutine): boolean {
  return routine.active && routine.deletedAt === null;
}

function byPosition(a: SequenceRoutine, b: SequenceRoutine): number {
  return a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * A próxima rotina da sequência (A, B, C, A...), circular pela `position`.
 *
 * - Sem histórico (`lastFinishedRoutineId` vazio ou desconhecido): a primeira.
 * - Rotina apagada ou inativa é pulada. A última feita continua marcando o ponto de partida mesmo que tenha sido
 *   apagada depois (a lápide guarda a posição): se a B foi a última e foi apagada, a próxima é a C, não a A.
 * - Com uma única rotina elegível, ela mesma é a próxima.
 * - Sem nenhuma rotina elegível: `undefined`.
 */
export function nextRoutine<T extends SequenceRoutine>(
  routines: readonly T[],
  lastFinishedRoutineId: string | null | undefined,
): T | undefined {
  const ordered = [...routines].sort(byPosition);
  if (!ordered.some(isEligible)) return undefined;

  const last = lastFinishedRoutineId
    ? ordered.findIndex((routine) => routine.id === lastFinishedRoutineId)
    : -1;
  if (last < 0) return ordered.find(isEligible);

  for (let step = 1; step <= ordered.length; step++) {
    const candidate = ordered[(last + step) % ordered.length];
    if (isEligible(candidate)) return candidate;
  }
  return undefined;
}
