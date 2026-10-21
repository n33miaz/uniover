import { Component, computed, input } from '@angular/core';

/** Camadas de um desenho, como no `TrainingGlyph`: `line` é o contorno e `fill` a mancha suave por trás. */
type Layer = 'line' | 'fill';

interface GlyphDefinition {
  readonly layers: readonly (readonly [Layer, string])[];
}

// Os ícones que só a tela de Progresso usa, no mesmo traço e na mesma grade de 24 dos do módulo. Decorativos: o texto do
// botão ou da linha é que informa.
const GLYPHS = {
  prev: { layers: [['line', 'M15 6l-6 6 6 6']] },
  next: { layers: [['line', 'M9 6l6 6-6 6']] },
  star: {
    layers: [
      ['fill', 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8L3.5 9.7l5.9-.8z'],
      ['line', 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8L3.5 9.7l5.9-.8z'],
    ],
  },
  calendar: {
    layers: [
      ['fill', 'M4 7h16v13H4z'],
      ['line', 'M4 7h16v13H4z M4 11h16 M8 4v4 M16 4v4'],
    ],
  },
  bars: {
    layers: [
      ['fill', 'M5 12h8v4H5z M5 5h12v4H5z'],
      ['line', 'M4 4v16 M5 5h12v4H5z M5 12h8v4H5z'],
    ],
  },
  download: { layers: [['line', 'M12 4v11 M7 11l5 5 5-5 M5 20h14']] },
  share: {
    layers: [
      [
        'line',
        'M17.5 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M6.5 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M17.5 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M8.7 10.8l6.6-3.6 M8.7 13.2l6.6 3.6',
      ],
    ],
  },
} as const satisfies Record<string, GlyphDefinition>;

export type ProgressGlyphName = keyof typeof GLYPHS;

/** Ícone da tela de Progresso: caminhos próprios em grade de 24; o tamanho vem de `--glyph-size` (20 px por padrão). */
@Component({
  selector: 'app-progress-glyph',
  template: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      @for (layer of layers(); track $index) {
        <path [attr.d]="layer[1]" [class]="layer[0]" />
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
      width: var(--glyph-size, 20px);
      height: var(--glyph-size, 20px);
    }
    svg {
      width: 100%;
      height: 100%;
      overflow: visible;
    }
    path {
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    path.fill {
      fill: currentColor;
      fill-opacity: 0.16;
      stroke: none;
    }
  `,
})
export class ProgressGlyph {
  readonly name = input.required<ProgressGlyphName>();

  protected readonly layers = computed<GlyphDefinition['layers']>(() => GLYPHS[this.name()].layers);
}
