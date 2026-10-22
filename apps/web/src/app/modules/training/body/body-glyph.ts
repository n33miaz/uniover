import { Component, computed, input } from '@angular/core';

/** Camadas de um desenho, como no `TrainingGlyph`: `line` é o contorno e `fill` a mancha suave por trás. */
type Layer = 'line' | 'fill';

interface GlyphDefinition {
  readonly layers: readonly (readonly [Layer, string])[];
}

// Os ícones que só a tela Corpo usa, no mesmo traço e na mesma grade de 24 dos do módulo. Decorativos: o texto do botão ou
// da linha é que informa.
const GLYPHS = {
  scale: {
    layers: [
      ['fill', 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
      [
        'line',
        'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M8 10a4 4 0 0 1 8 0z M12 10l1.8-2',
      ],
    ],
  },
  drop: {
    layers: [
      ['fill', 'M12 3s6 6.2 6 11a6 6 0 0 1-12 0c0-4.800 6-11 6-11z'],
      ['line', 'M12 3s6 6.200 6 11a6 6 0 0 1-12 0c0-4.800 6-11 6-11z'],
    ],
  },
  ruler: {
    layers: [
      ['fill', 'M3 17.500L17.500 3l3.500 3.500L6.500 21z'],
      [
        'line',
        'M3 17.500L17.500 3l3.500 3.500L6.500 21z M7 13.500l2 2 M10.500 10l2 2 M14 6.500l2 2',
      ],
    ],
  },
  user: {
    layers: [
      ['fill', 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
      ['line', 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M4 20a8 8 0 0 1 16 0'],
    ],
  },
  flame: {
    layers: [
      [
        'fill',
        'M12 3c.8 3.500 5 5 5 10a5 5 0 0 1-10 0c0-2 .8-3.200 2-4.200.2 1.700 1 2.700 2 2.700C10.500 8 11 6 12 3z',
      ],
      [
        'line',
        'M12 3c.8 3.500 5 5 5 10a5 5 0 0 1-10 0c0-2 .8-3.200 2-4.200.2 1.700 1 2.700 2 2.700C10.500 8 11 6 12 3z',
      ],
    ],
  },
  camera: {
    layers: [
      ['fill', 'M4 8h3l1.800-2.500h6.400L17 8h3v11H4z'],
      [
        'line',
        'M4 8h3l1.800-2.500h6.400L17 8h3v11H4z M12 10.500a3.500 3.500 0 1 0 0 7 3.500 3.500 0 0 0 0-7z',
      ],
    ],
  },
  gallery: {
    layers: [
      ['fill', 'M4 5h16v14H4z'],
      ['line', 'M4 5h16v14H4z M4 16l5-5 4 4 2.500-2.500L20 17 M8.500 9h.01'],
    ],
  },
  compare: {
    layers: [['line', 'M4 5h6v14H4z M14 5h6v14h-6z M12 3v18']],
  },
  share: {
    layers: [['line', 'M12 15V4 M8 8l4-4 4 4 M5 13v6h14v-6']],
  },
} as const satisfies Record<string, GlyphDefinition>;

export type BodyGlyphName = keyof typeof GLYPHS;

/** Ícone da tela Corpo: caminhos próprios em grade de 24; o tamanho vem de `--glyph-size` (20 px por padrão). */
@Component({
  selector: 'app-body-glyph',
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
export class BodyGlyph {
  readonly name = input.required<BodyGlyphName>();

  protected readonly layers = computed<GlyphDefinition['layers']>(() => GLYPHS[this.name()].layers);
}
