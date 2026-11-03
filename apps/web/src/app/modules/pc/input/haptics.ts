/**
 * Vibração curta onde existe (o iOS não tem; nele não acontece nada), respeitando "reduzir movimento". É um aviso de
 * que o toque valeu, nunca a única pista: o clique também aparece na tela.
 */
export function tick(ms = 8): void {
  try {
    if (typeof navigator.vibrate !== 'function') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    navigator.vibrate(ms);
  } catch {
    // sem vibração: nada a fazer
  }
}
