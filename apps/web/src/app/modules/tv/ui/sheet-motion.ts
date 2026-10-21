/**
 * Teto da saída da folha (ms). A transição do CSS dura menos que isto; se o fim dela nunca chegar (aba em segundo
 * plano, estilo que não carregou), a folha sai do mesmo jeito e quem a usa nunca fica preso.
 */
export const SHEET_EXIT_LIMIT_MS = 300;

function toMilliseconds(token: string): number {
  const value = parseFloat(token);
  if (!Number.isFinite(value)) return 0;
  return token.trim().endsWith('ms') ? value : value * 1000;
}

/**
 * A folha só espera a saída quando o CSS tem uma transição de verdade e a pessoa não pediu menos movimento. Sem
 * `matchMedia` ou sem estilo calculado (teste em jsdom), ela sai na hora: nada a esperar.
 */
function hasExitMotion(dialog: HTMLDialogElement): boolean {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
    const durations = getComputedStyle(dialog).transitionDuration.split(',').map(toMilliseconds);
    return Math.max(0, ...durations) > 0;
  } catch {
    return false;
  }
}

/**
 * Tira a folha de cena com uma saída suave e só então chama `done` (quem emite o `closed` e desmonta o componente).
 * A saída é do CSS: marcar `data-closing` inverte a entrada. Espera o fim da transição, com o teto
 * `SHEET_EXIT_LIMIT_MS`; com "reduzir movimento" (ou sem transição) chama `done` de imediato.
 */
export function leaveSheet(dialog: HTMLDialogElement, done: () => void): void {
  if (dialog.hasAttribute('data-closing')) return;
  if (!hasExitMotion(dialog)) {
    done();
    return;
  }
  dialog.setAttribute('data-closing', '');
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    dialog.removeEventListener('transitionend', onEnd);
    done();
  };
  // As transições do fundo também sobem até aqui; só a da própria folha encerra a espera.
  const onEnd = (event: Event) => {
    if (event.target === dialog) finish();
  };
  dialog.addEventListener('transitionend', onEnd);
  const timer = setTimeout(finish, SHEET_EXIT_LIMIT_MS);
}
