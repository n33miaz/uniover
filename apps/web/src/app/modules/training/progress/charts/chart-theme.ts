/**
 * Cores do gráfico. O desenho é em canvas e canvas não lê `var(--a-*)`: as cores saem do tema do app (as mesmas das
 * demais telas, nunca as da biblioteca) por `getComputedStyle`, e são lidas de novo quando o tema muda. Só os tokens de
 * valor simples entram (`--a-accent` e companhia); os que são `color-mix()` voltariam como texto sem resolver.
 */
export interface ChartColors {
  /** Linha e pontos. */
  readonly accent: string;
  /** Miolo dos pontos e anel do ponto em destaque (a cor do cartão). */
  readonly surface: string;
  /** Texto dos eixos. */
  readonly ink2: string;
  /** Linhas de grade. */
  readonly line: string;
  /** Linha da meta e o texto dela. */
  readonly goal: string;
  readonly font: string;
}

const FALLBACK: ChartColors = {
  accent: '#3b6b4b',
  surface: '#ffffff',
  ink2: '#46544a',
  line: '#d0dad0',
  goal: '#8a5200',
  font: 'system-ui, sans-serif',
};

export function readChartColors(element: Element): ChartColors {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    accent: token('--a-accent', FALLBACK.accent),
    surface: token('--a-surface', FALLBACK.surface),
    ink2: token('--a-ink2', FALLBACK.ink2),
    line: token('--a-line', FALLBACK.line),
    goal: token('--a-warn', FALLBACK.goal),
    font: style.fontFamily || FALLBACK.font,
  };
}

/**
 * Avisa quando o tema muda: o serviço de tema troca o atributo `data-theme` da raiz, e o sistema pode trocar a
 * preferência sem que o atributo mude (modo automático). Devolve a função que desliga a escuta.
 */
export function watchTheme(doc: Document, onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const media = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    media?.removeEventListener('change', onChange);
  };
}
