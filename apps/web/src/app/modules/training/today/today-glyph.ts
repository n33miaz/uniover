import { Component, computed, input } from '@angular/core';

/**
 * Camadas de um desenho (as mesmas do glifo da casca): `line` é o contorno, `fill` a mancha suave por trás, `solid` um
 * detalhe cheio.
 */
type Layer = 'line' | 'fill' | 'solid';

// Desenhos que só o treino ao vivo usa (a casca tem o seu conjunto, que não é meu). Grade de 24, só caminhos, todos
// decorativos: o texto do botão ou da linha é que informa.
const GLYPHS = {
  star: {
    layers: [
      ['fill', 'M12 3.2l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8z'],
      ['line', 'M12 3.2l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8z'],
    ],
  },
  swap: { layers: [['line', 'M7 7h12 M15 3l4 4-4 4 M17 17H5 M9 13l-4 4 4 4']] },
  skip: {
    layers: [
      ['fill', 'M5 5l9 7-9 7z'],
      ['line', 'M5 5l9 7-9 7z M18 5v14'],
    ],
  },
  dots: {
    layers: [
      [
        'solid',
        'M5 12m-1.7 0a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0 M12 12m-1.7 0a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0 M19 12m-1.7 0a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0',
      ],
    ],
  },
  lock: {
    layers: [
      ['fill', 'M5 11h14v9H5z'],
      ['line', 'M7 11V8a5 5 0 0 1 10 0v3 M5 11h14v9H5z M12 15v2'],
    ],
  },
  screen: {
    layers: [
      ['fill', 'M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'],
      ['line', 'M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M11 18h2'],
    ],
  },
  clock: {
    layers: [
      ['fill', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
      ['line', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7.5V12l3 2'],
    ],
  },
  play: {
    layers: [
      ['fill', 'M7 4.5l12 7.5-12 7.5z'],
      ['line', 'M7 4.5l12 7.5-12 7.5z'],
    ],
  },
} as const satisfies Record<string, { readonly layers: readonly (readonly [Layer, string])[] }>;

export type TodayGlyphName = keyof typeof GLYPHS;

/** Ícone extra do treino ao vivo: caminhos próprios em grade de 24; o tamanho vem de `--glyph-size` (20 px por padrão). */
@Component({
  selector: 'app-today-glyph',
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
export class TodayGlyph {
  readonly name = input.required<TodayGlyphName>();

  protected readonly layers = computed<readonly (readonly [Layer, string])[]>(
    () => GLYPHS[this.name()].layers,
  );
}
