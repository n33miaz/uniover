import { Component, computed, input } from '@angular/core';

/**
 * Camadas de um desenho: `line` é o contorno, `fill` é a mancha suave por trás (a mesma cor com pouca opacidade),
 * `draw` é um traço que se desenha sozinho na entrada (só o visto de "pronto" e de "cumprido").
 */
type Layer = 'line' | 'fill' | 'draw';

interface GlyphDefinition {
  readonly layers: readonly (readonly [Layer, string])[];
}

const CIRCLE = 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z';
const ENVELOPE =
  'M4.5 6h15A1.5 1.5 0 0 1 21 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5v-9A1.5 1.5 0 0 1 4.5 6z';
const PADLOCK =
  'M6.5 10.5h11a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5V12a1.5 1.5 0 0 1 1.5-1.5z';
const SHIELD = 'M12 3.2l7 2.7v5.4c0 4.4-2.9 7.7-7 9.5-4.1-1.8-7-5.1-7-9.5V5.9z';
const TRIANGLE =
  'M10.3 4.6L2.9 17.5a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z';
const SLASH = 'M4 4l16 16';

// Desenhos próprios das telas de entrada, em grade de 24. Só caminhos: o desenho inteiro vem de dados.
const GLYPHS = {
  eye: {
    layers: [
      ['line', 'M2.5 12s3.6-6.5 9.5-6.5S21.5 12 21.5 12s-3.6 6.5-9.5 6.5S2.5 12 2.5 12z'],
      ['line', 'M12 9.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5z'],
    ],
  },
  'eye-off': {
    layers: [
      [
        'line',
        'M9.9 5.7A9.6 9.6 0 0 1 12 5.5c5.9 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.4 3.2 M6.5 7.4A16 16 0 0 0 2.5 12s3.6 6.5 9.5 6.5a9.4 9.4 0 0 0 3.5-.7 M9.9 9.9a2.75 2.75 0 0 0 3.9 3.9',
      ],
      ['line', SLASH],
    ],
  },
  'check-circle': {
    layers: [
      ['fill', CIRCLE],
      ['line', CIRCLE],
      ['draw', 'M8.2 12.4l2.7 2.7 5-5.6'],
    ],
  },
  circle: { layers: [['line', CIRCLE]] },
  'alert-circle': {
    layers: [
      ['fill', CIRCLE],
      ['line', CIRCLE],
      ['line', 'M12 7.8v5 M12 16.2h.01'],
    ],
  },
  warning: {
    layers: [
      ['fill', TRIANGLE],
      ['line', TRIANGLE],
      ['line', 'M12 9.5v4 M12 17h.01'],
    ],
  },
  clock: {
    layers: [
      ['fill', CIRCLE],
      ['line', CIRCLE],
      ['line', 'M12 7.8V12l3 1.8'],
    ],
  },
  lock: {
    layers: [
      ['fill', PADLOCK],
      ['line', PADLOCK],
      ['line', 'M8 10.5V8a4 4 0 0 1 8 0v2.5 M12 14.2v2.2'],
    ],
  },
  'wifi-off': {
    layers: [
      [
        'line',
        'M2.8 9.2A14 14 0 0 1 7 6.6 M21.2 9.2A14 14 0 0 0 12 5.5c-.6 0-1.2 0-1.8.1 M6 12.7A9 9 0 0 1 9 11 M18 12.7a9 9 0 0 0-3.4-1.9 M9.2 16.2a4.2 4.2 0 0 1 5.6 0 M12 19.5h.01',
      ],
      ['line', SLASH],
    ],
  },
  'link-off': {
    layers: [
      [
        'line',
        'M10.2 6.2l1-1a4 4 0 0 1 5.7 5.7l-1 1 M13.8 17.8l-1 1a4 4 0 0 1-5.7-5.7l1-1 M9 15l2.2-2.2 M12.8 11.2L15 9',
      ],
      ['line', SLASH],
    ],
  },
  'mail-off': {
    layers: [
      ['fill', ENVELOPE],
      ['line', ENVELOPE],
      ['line', 'M3.5 7.5l8.5 6 8.5-6'],
      ['line', SLASH],
    ],
  },
  shield: {
    layers: [
      ['fill', SHIELD],
      ['line', SHIELD],
      ['draw', 'M9 12l2.2 2.2L15.2 10'],
    ],
  },
  caps: {
    layers: [
      ['fill', 'M12 4.5l7 7.5h-4v4.5H9V12H5z'],
      ['line', 'M12 4.5l7 7.5h-4v4.5H9V12H5z M9 20h6'],
    ],
  },
} as const satisfies Record<string, GlyphDefinition>;

export type AuthGlyphName = keyof typeof GLYPHS;

/** Desenho decorativo das telas de entrada: o texto vizinho é que informa; por isso fica oculto para leitores de tela. */
@Component({
  selector: 'app-auth-glyph',
  template: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      @for (layer of layers(); track $index) {
        <path
          [attr.d]="layer[1]"
          [attr.pathLength]="layer[0] === 'draw' ? 1 : null"
          [class]="layer[0]"
        />
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
      width: var(--glyph-size, 24px);
      height: var(--glyph-size, 24px);
    }
    svg {
      width: 100%;
      height: 100%;
      overflow: visible;
    }
    path {
      fill: none;
      stroke: currentColor;
      stroke-width: 1.75;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    path.fill {
      fill: currentColor;
      fill-opacity: 0.16;
      stroke: none;
    }
    /* O visto se desenha na entrada (só CSS); sem movimento ele já nasce completo. */
    path.draw {
      stroke-dasharray: 1;
      stroke-dashoffset: 0;
      animation: auth-draw var(--dur-slow) var(--ease-out) 120ms backwards;
    }
    @keyframes auth-draw {
      from {
        stroke-dashoffset: 1;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      path.draw {
        animation: none;
      }
    }
  `,
})
export class AuthGlyph {
  readonly name = input.required<AuthGlyphName>();

  protected readonly layers = computed<readonly (readonly [Layer, string])[]>(
    () => GLYPHS[this.name()].layers,
  );
}
