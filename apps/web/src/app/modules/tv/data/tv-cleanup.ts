import { TvCleanupResult } from './tv-types';

/**
 * Abaixo disto o "liberou" é ruído: a memória disponível oscila de um segundo para o outro por conta própria, e dizer
 * "liberou 4 MB" depois de fechar vários apps pareceria erro. O valor mostrado é o relatório do agente, arredondado.
 */
export const CLEANUP_FREED_MIN_MB = 20;

/** Memória liberada para mostrar: arredondada para a dezena ("cerca de 380 MB"), ou `null` se não há o que dizer. */
export function freedMegabytes(result: Pick<TvCleanupResult, 'freedMb'>): number | null {
  const freed = result.freedMb;
  if (typeof freed !== 'number' || !Number.isFinite(freed) || freed < CLEANUP_FREED_MIN_MB) {
    return null;
  }
  return Math.round(freed / 10) * 10;
}

/**
 * O aviso do que a limpeza fez, só com o que o agente mediu: apps fechados e, se a memória pôde ser lida e subiu o
 * bastante, quanto foi liberado. Sem número honesto não se promete nenhum ("Nada para fechar."). Etapas que falharam
 * ganham uma frase no fim, para o resultado não parecer mais completo do que foi.
 */
export function describeCleanup(
  result: Pick<TvCleanupResult, 'closedApps' | 'freedMb' | 'failedSteps'>,
): string {
  const apps = result.closedApps;
  const mb = freedMegabytes(result);
  let text: string;
  if (apps <= 0) {
    text =
      mb === null
        ? $localize`:@@tv.cleanup.nothing:Nada para fechar.`
        : $localize`:@@tv.cleanup.freed-only:Liberou cerca de ${mb}:mb: MB.`;
  } else if (mb === null) {
    text =
      apps === 1
        ? $localize`:@@tv.cleanup.closed-one:Fechou 1 app.`
        : $localize`:@@tv.cleanup.closed-many:Fechou ${apps}:apps: apps.`;
  } else {
    text =
      apps === 1
        ? $localize`:@@tv.cleanup.closed-one-freed:Fechou 1 app e liberou cerca de ${mb}:mb: MB.`
        : $localize`:@@tv.cleanup.closed-many-freed:Fechou ${apps}:apps: apps e liberou cerca de ${mb}:mb: MB.`;
  }
  if ((result.failedSteps?.length ?? 0) > 0) {
    text += ' ' + $localize`:@@tv.cleanup.some-failed:Algumas etapas não deram certo.`;
  }
  return text;
}
