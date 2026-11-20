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
  /** O piso desta medida (sem ele, `MIN_FIT_HEIGHT`). */
  readonly minHeight?: number;
}

/** Abaixo disto a tela não encolhe mais (em paisagem com o teclado aberto): a página rola em vez de sumir. */
export const MIN_FIT_HEIGHT = 240;

/**
 * O piso com o teclado do celular aberto na tela do mouse: só o eco e a barra de ações (duas fileiras) com o respiro entre
 * eles. A superfície encolhe até sumir antes de o eco ou a barra irem para trás do teclado.
 */
export const MIN_TYPING_FIT_HEIGHT = 168;

/**
 * Quanto da janela fica abaixo da parte visível agora (o teclado do iPhone, que cobre sem encolher a janela, ou o que o
 * Safari deixou para baixo ao rolar até o campo), sem o piso de `coveredByKeyboard`: com o teclado aberto qualquer pixel
 * conta. No Android (a janela já encolhe) dá 0.
 */
export function belowVisibleArea(win: Window): number {
  const viewport = win.visualViewport;
  if (!viewport) return 0;
  return Math.max(0, Math.round(win.innerHeight - viewport.offsetTop - viewport.height));
}

/**
 * Quanto sobra entre o início da tela do PC e a barra de abas. O aviso de versão nova mora fora do cabeçalho do módulo e
 * empurra a página para baixo, e uma fórmula fixa não o enxerga: a conta parte de onde a tela realmente começa. Nunca
 * devolve menos que `MIN_FIT_HEIGHT`.
 */
export function availableHeight(fit: ViewportFit): number {
  const room = fit.viewportHeight - fit.keyboardInset - fit.top - fit.tabsHeight - fit.bottomGap;
  return Math.max(fit.minHeight ?? MIN_FIT_HEIGHT, Math.floor(room));
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
 *
 * No modo teclado (uma tela de dentro marcada com `data-typing`) a tela termina onde termina a parte visível: o eco do que
 * se digita e a barra de ações ficam logo acima do teclado, mesmo quando o iPhone cobre a janela sem rolar ou rola só um
 * pedaço (a conta segue a rolagem da parte visível, não só a mudança de tamanho).
 */
export function watchAvailableHeight(
  doc: Document,
  host: HTMLElement,
  apply: (height: number, tabsHeight: number) => void,
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
    const tabsHeight = tabs?.offsetHeight ?? 0;
    const typing = host.querySelector('[data-typing]') !== null;
    apply(
      availableHeight({
        viewportHeight: win.innerHeight,
        keyboardInset: typing ? belowVisibleArea(win) : Number.isFinite(inset) ? inset : 0,
        top: host.getBoundingClientRect().top + win.scrollY,
        tabsHeight,
        bottomGap,
        minHeight: typing ? MIN_TYPING_FIT_HEIGHT : MIN_FIT_HEIGHT,
      }),
      tabsHeight,
    );
  };
  // Vários avisos no mesmo quadro viram uma medida só.
  const schedule = () => {
    if (frame === 0) frame = win.requestAnimationFrame(measure);
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  observer?.observe(doc.body);
  // Entrar e sair do modo teclado muda a conta (a barra de abas some, a tela passa a seguir a parte visível).
  const typingObserver =
    typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
  typingObserver?.observe(host, {
    attributes: true,
    attributeFilter: ['data-typing'],
    subtree: true,
  });
  win.addEventListener('resize', schedule);
  win.addEventListener('orientationchange', schedule);
  win.visualViewport?.addEventListener('resize', schedule);
  win.visualViewport?.addEventListener('scroll', schedule);
  measure();
  return {
    remeasure: measure,
    stop: () => {
      observer?.disconnect();
      typingObserver?.disconnect();
      win.removeEventListener('resize', schedule);
      win.removeEventListener('orientationchange', schedule);
      win.visualViewport?.removeEventListener('resize', schedule);
      win.visualViewport?.removeEventListener('scroll', schedule);
      if (frame !== 0) win.cancelAnimationFrame(frame);
    },
  };
}
