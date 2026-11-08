/** Entradas da conta da altura que sobra para a tela do PC (todas em pixels do CSS). */
export interface ViewportFit {
  /** Altura da janela. */
  readonly viewportHeight: number;
  /** Quanto o teclado virtual cobre da janela sem a encolher (`--kb-inset`; 0 quando a janela já encolhe sozinha). */
  readonly keyboardInset: number;
  /** Onde a tela do PC começa, medido da ponta de cima da página (avisos e cabeçalho já contam). */
  readonly top: number;
  /** Altura da barra de abas, que cola no rodapé da janela. */
  readonly tabsHeight: number;
  /** O respiro que o conteúdo da página deixa entre o fim da tela e a barra de abas (o preenchimento de baixo do `main`). */
  readonly bottomGap: number;
}

/** Abaixo disto a tela não encolhe mais (em paisagem com o teclado aberto): a página rola em vez de sumir. */
export const MIN_FIT_HEIGHT = 240;

/**
 * Quanto sobra entre o início da tela do PC e a barra de abas. O aviso de versão nova mora fora do cabeçalho do módulo e
 * empurra a página para baixo, e uma fórmula fixa não o enxerga: a conta parte de onde a tela realmente começa. Nunca
 * devolve menos que `MIN_FIT_HEIGHT`.
 */
export function availableHeight(fit: ViewportFit): number {
  const room = fit.viewportHeight - fit.keyboardInset - fit.top - fit.tabsHeight - fit.bottomGap;
  return Math.max(MIN_FIT_HEIGHT, Math.floor(room));
}

/** Quem mede: `remeasure` mede de novo agora (a tela mudou de forma por dentro) e `stop` para de ouvir. */
export interface ViewportWatch {
  remeasure(): void;
  stop(): void;
}

/**
 * Mede a janela e avisa quando a altura disponível muda: ao redimensionar, girar o aparelho, abrir ou fechar o teclado
 * virtual e quando o aviso de versão aparece ou some (o corpo da página muda de altura). `host` é o elemento onde a tela
 * começa.
 */
export function watchAvailableHeight(
  doc: Document,
  host: HTMLElement,
  apply: (height: number) => void,
): ViewportWatch {
  const win = doc.defaultView;
  if (!win) return { remeasure: () => undefined, stop: () => undefined };
  let frame = 0;
  const measure = () => {
    frame = 0;
    const tabs = doc.querySelector<HTMLElement>('app-tab-bar');
    const inset = Number.parseFloat(
      win.getComputedStyle(doc.documentElement).getPropertyValue('--kb-inset'),
    );
    const px = (value: string) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const main = host.closest('main');
    const bottomGap =
      (main ? px(win.getComputedStyle(main).paddingBottom) : 0) +
      px(win.getComputedStyle(host).marginBottom);
    apply(
      availableHeight({
        viewportHeight: win.innerHeight,
        keyboardInset: Number.isFinite(inset) ? inset : 0,
        top: host.getBoundingClientRect().top + win.scrollY,
        tabsHeight: tabs?.offsetHeight ?? 0,
        bottomGap,
      }),
    );
  };
  // Vários avisos no mesmo quadro viram uma medida só.
  const schedule = () => {
    if (frame === 0) frame = win.requestAnimationFrame(measure);
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  observer?.observe(doc.body);
  win.addEventListener('resize', schedule);
  win.addEventListener('orientationchange', schedule);
  win.visualViewport?.addEventListener('resize', schedule);
  measure();
  return {
    remeasure: measure,
    stop: () => {
      observer?.disconnect();
      win.removeEventListener('resize', schedule);
      win.removeEventListener('orientationchange', schedule);
      win.visualViewport?.removeEventListener('resize', schedule);
      if (frame !== 0) win.cancelAnimationFrame(frame);
    },
  };
}
