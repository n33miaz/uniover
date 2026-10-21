import { Component, computed, input } from '@angular/core';

/**
 * Camadas de um desenho: `line` é o contorno, `fill` é a mancha suave por trás (a mesma cor com pouca opacidade),
 * `solid` é um detalhe cheio.
 */
type Layer = 'line' | 'fill' | 'solid';

interface GlyphDefinition {
  readonly layers: readonly (readonly [Layer, string])[];
}

// Desenhos próprios do módulo, em grade de 24. Só caminhos: o desenho inteiro vem de dados, sem atributo solto no
// modelo. Todos decorativos: o texto do botão ou da linha é que informa.
const GLYPHS = {
  search: { layers: [['line', 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M20 20l-4.4-4.4']] },
  plus: { layers: [['line', 'M12 5v14 M5 12h14']] },
  minus: { layers: [['line', 'M5 12h14']] },
  close: { layers: [['line', 'M6 6l12 12 M18 6L6 18']] },
  check: { layers: [['line', 'M5 12.5l4.5 4.5L19 7.5']] },
  back: { layers: [['line', 'M19 12H5 M11 18l-6-6 6-6']] },
  next: { layers: [['line', 'M9 6l6 6-6 6']] },
  up: { layers: [['line', 'M6 15l6-6 6 6']] },
  down: { layers: [['line', 'M6 9l6 6 6-6']] },
  grip: {
    layers: [
      [
        'solid',
        'M9 6m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M15 6m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M9 12m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M15 12m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M9 18m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M15 18m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
      ],
    ],
  },
  trash: {
    layers: [['line', 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3']],
  },
  pencil: {
    layers: [
      ['fill', 'M4 20l1-4 11-11 3 3L8 19z'],
      ['line', 'M4 20l1-4 11-11 3 3L8 19z M14 7l3 3'],
    ],
  },
  target: {
    layers: [
      ['fill', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
      ['line', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
    ],
  },
  sliders: {
    layers: [
      [
        'line',
        'M4 7h9 M17 7h3 M15 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M4 17h3 M11 17h9 M9 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
      ],
    ],
  },
  chart: { layers: [['line', 'M4 4v16h16 M8 16v-5 M13 16V8 M18 16v-3']] },
  list: { layers: [['line', 'M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01']] },
  link: {
    layers: [
      [
        'line',
        'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
      ],
    ],
  },
  info: {
    layers: [
      ['fill', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
      ['line', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v5 M12 8h.01'],
    ],
  },
  alert: {
    layers: [
      ['fill', 'M12 3.5L2.5 20h19z'],
      ['line', 'M12 3.5L2.5 20h19z M12 10v4 M12 17h.01'],
    ],
  },
  offline: {
    layers: [
      [
        'line',
        'M2 8.8a15 15 0 0 1 4-2.5 M22 8.8a15 15 0 0 0-8-3.7 M5 12.9a10 10 0 0 1 3.2-2 M19 12.9a10 10 0 0 0-3.5-2.2 M8.5 16.4a5 5 0 0 1 7 0 M12 20h.01 M3 3l18 18',
      ],
    ],
  },
  refresh: {
    layers: [['line', 'M20 11a8 8 0 0 0-14-4L4 9 M4 4v5h5 M4 13a8 8 0 0 0 14 4l2-2 M20 20v-5h-5']],
  },
  dumbbell: {
    layers: [
      ['fill', 'M5.2 7.5h2.1v9H5.2z M16.7 7.5h2.1v9h-2.1z'],
      [
        'line',
        'M7.3 6.5v11 M16.7 6.5v11 M4.2 9v6 M19.8 9v6 M7.3 12h9.4 M2.5 10.8v2.4 M21.5 10.8v2.4',
      ],
    ],
  },
  hourglass: {
    layers: [
      ['fill', 'M7 3h10v3.5L12 12 7 6.5z'],
      ['line', 'M7 3h10 M7 21h10 M7 3v3.5L12 12 7 17.5V21 M17 3v3.5L12 12l5 5.5V21'],
    ],
  },
} as const satisfies Record<string, GlyphDefinition>;

export type TrainingGlyphName = keyof typeof GLYPHS;

/** Ícone do Treino: caminhos próprios em grade de 24; o tamanho vem de `--glyph-size` (20 px por padrão). */
@Component({
  selector: 'app-training-glyph',
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
    path.solid {
      fill: currentColor;
      stroke: none;
    }
  `,
})
export class TrainingGlyph {
  readonly name = input.required<TrainingGlyphName>();

  protected readonly layers = computed<GlyphDefinition['layers']>(() => GLYPHS[this.name()].layers);
}
