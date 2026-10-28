/** Abaixo disto a diferença entre a janela e a área visível é barra do navegador, não teclado. */
const KEYBOARD_MIN_PX = 80;

/** Quanto da janela o teclado virtual cobre, dado o que o navegador informa (0 quando não há teclado). */
export function coveredByKeyboard(
  innerHeight: number,
  viewport: Pick<VisualViewport, 'height' | 'offsetTop'>,
): number {
  const covered = innerHeight - viewport.height - viewport.offsetTop;
  return covered >= KEYBOARD_MIN_PX ? Math.round(covered) : 0;
}

/**
 * Mantém `--kb-inset` (raiz) igual ao que o teclado cobre. No iOS Safari a janela não encolhe com o teclado, então
 * rodapés fixos ficariam atrás dele; eles sobem por `bottom: var(--kb-inset)`. No Chrome do Android o meta viewport
 * (`interactive-widget=resizes-content`) já encolhe a página, a conta dá 0 e nada é somado duas vezes.
 * Devolve a função que desfaz a escuta.
 */
export function watchKeyboardInset(win: Window, root: HTMLElement): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => undefined;
  const update = () =>
    root.style.setProperty('--kb-inset', `${coveredByKeyboard(win.innerHeight, viewport)}px`);
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    root.style.removeProperty('--kb-inset');
  };
}
