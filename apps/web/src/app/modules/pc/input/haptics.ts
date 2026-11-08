/** A pessoa pode desligar a vibração nos ajustes; ligada por padrão. */
let enabled = true;

export function setHapticsEnabled(value: boolean): void {
  enabled = value;
}

/** O aparelho vibra (o iOS não tem a API): o ajuste só faz sentido onde isto é verdade. */
export function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

/**
 * Vibração curta onde existe (o iOS não tem; nele não acontece nada), respeitando "reduzir movimento". É um aviso de
 * que o toque valeu, nunca a única pista: o clique também aparece na tela.
 */
export function tick(ms = 8): void {
  if (!enabled) return;
  try {
    if (typeof navigator.vibrate !== 'function') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    navigator.vibrate(ms);
  } catch {
    // sem vibração: nada a fazer
  }
}
