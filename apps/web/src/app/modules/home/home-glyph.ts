import { Component, computed, input } from '@angular/core';
import { ModuleIconName } from '../../core/modules/module-registry';

/**
 * Camadas de um desenho: `line` é o contorno, `fill` é a mancha suave por trás (a mesma cor com pouca opacidade),
 * `solid` é um detalhe cheio. O desenho em duas camadas dá profundidade sem precisar de imagem.
 */
type Layer = 'line' | 'fill' | 'solid';

interface GlyphDefinition {
  readonly box: string;
  readonly layers: readonly (readonly [Layer, string])[];
}

// Desenhos próprios do app, em grade de 24 (ícones) ou de 96x64 (cenas da saudação). Só caminhos: o desenho
// inteiro vem de dados, sem atributo solto no modelo.
const GLYPHS = {
  tv: {
    box: '0 0 24 24',
    layers: [
      ['fill', 'M5 5h14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z'],
      ['line', 'M5 5h14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z'],
      ['line', 'M8.5 21h7 M12 17.5V21'],
      ['solid', 'M10.4 8.6l4.2 2.4-4.2 2.4z'],
    ],
  },
  // TV Livre: a tela da TV com o relógio em cima e a fileira de círculos embaixo, o desenho da própria home.
  launcher: {
    box: '0 0 24 24',
    layers: [
      ['fill', 'M5 4h14a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
      [
        'line',
        'M5 4h14a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M8.5 20.5h7 M12 17.5v3',
      ],
      ['line', 'M9 8h6'],
      [
        'solid',
        'M8 12.8m-1.1 0a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0-2.2 0 M12 12.8m-1.1 0a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0-2.2 0 M16 12.8m-1.1 0a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0-2.2 0',
      ],
    ],
  },
  dumbbell: {
    box: '0 0 24 24',
    layers: [
      ['fill', 'M5.2 6h2.1v12H5.2z M16.7 6h2.1v12h-2.1z'],
      ['line', 'M7.3 5v14 M16.7 5v14 M4.2 7.5v9 M19.8 7.5v9 M7.3 12h9.4 M2.5 10.5v3 M21.5 10.5v3'],
    ],
  },
  // Módulos planejados: coração com pulso (saúde e eventos), pilha de servidores (monitor), ondas de rede,
  // nuvem com seta (backup), sino (avisos) e tela com ponteiro (controle do PC).
  health: {
    box: '0 0 24 24',
    layers: [
      [
        'fill',
        'M12 20.2C5.6 16.1 3.5 12.6 3.5 9.6A4.6 4.6 0 0 1 12 7.4a4.6 4.6 0 0 1 8.5 2.2c0 3-2.1 6.5-8.5 10.6z',
      ],
      [
        'line',
        'M12 20.2C5.6 16.1 3.5 12.6 3.5 9.6A4.6 4.6 0 0 1 12 7.4a4.6 4.6 0 0 1 8.5 2.2c0 3-2.1 6.5-8.5 10.6z',
      ],
      ['line', 'M7 12.5h2.6l1.6-3.2 2.4 5.6 1.5-2.4H17'],
    ],
  },
  monitor: {
    box: '0 0 24 24',
    layers: [
      [
        'fill',
        'M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v3.5A1.5 1.5 0 0 1 19 11H5A1.5 1.5 0 0 1 3.5 9.5V6A1.5 1.5 0 0 1 5 4.5z',
      ],
      [
        'line',
        'M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v3.5A1.5 1.5 0 0 1 19 11H5A1.5 1.5 0 0 1 3.5 9.5V6A1.5 1.5 0 0 1 5 4.5z M5 13.5h14a1.5 1.5 0 0 1 1.5 1.5v3.5A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5V15A1.5 1.5 0 0 1 5 13.5z M12 7.75h4.5 M12 16.75h4.5',
      ],
      [
        'solid',
        'M7.5 7.75m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0 M7.5 16.75m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
      ],
    ],
  },
  network: {
    box: '0 0 24 24',
    layers: [
      ['fill', 'M3.5 9.5a12 12 0 0 1 17 0L12 19z'],
      [
        'line',
        'M3.5 9.5a12 12 0 0 1 17 0 M6.6 12.6a7.7 7.7 0 0 1 10.8 0 M9.5 15.6a3.6 3.6 0 0 1 5 0',
      ],
      ['solid', 'M12 19m-1.4 0a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0'],
    ],
  },
  backup: {
    box: '0 0 24 24',
    layers: [
      ['fill', 'M7.5 18.5a4 4 0 0 1-.7-7.9 5.5 5.5 0 0 1 10.6-.5A4.2 4.2 0 0 1 17 18.5z'],
      [
        'line',
        'M7.5 18.5a4 4 0 0 1-.7-7.9 5.5 5.5 0 0 1 10.6-.5A4.2 4.2 0 0 1 17 18.5z M12 16v-5 M9.7 13.2L12 10.9l2.3 2.3',
      ],
    ],
  },
  bell: {
    box: '0 0 24 24',
    layers: [
      ['fill', 'M18 9a6 6 0 0 0-12 0c0 6.5-2.5 8.5-2.5 8.5h17S18 15.5 18 9z'],
      [
        'line',
        'M18 9a6 6 0 0 0-12 0c0 6.5-2.5 8.5-2.5 8.5h17S18 15.5 18 9z M10.2 20.5a2 2 0 0 0 3.6 0',
      ],
    ],
  },
  desktop: {
    box: '0 0 24 24',
    layers: [
      [
        'fill',
        'M4 4.5h16a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15V6A1.5 1.5 0 0 1 4 4.5z',
      ],
      [
        'line',
        'M4 4.5h16a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15V6A1.5 1.5 0 0 1 4 4.5z M9.5 20.5h5 M12 16.5v4',
      ],
      ['solid', 'M9 6.4l5.2 2.4-2.2.8-.9 2.2z'],
    ],
  },
  grid: {
    box: '0 0 24 24',
    layers: [
      ['fill', 'M4 4h6.5v6.5H4z M13.5 13.5H20V20h-6.5z'],
      ['line', 'M4 4h6.5v6.5H4z M13.5 4H20v6.5h-6.5z M4 13.5h6.5V20H4z M13.5 13.5H20V20h-6.5z'],
    ],
  },
  sliders: {
    box: '0 0 24 24',
    layers: [
      ['line', 'M4 7h8 M18 7h2 M4 12h2 M12 12h8 M4 17h9 M19 17h1'],
      [
        'solid',
        'M15 7m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0 M9 12m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0 M16 17m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0',
      ],
    ],
  },
  laptop: {
    box: '0 0 24 24',
    layers: [
      ['fill', 'M6 5.5h12a1 1 0 0 1 1 1V15H5V6.5a1 1 0 0 1 1-1z'],
      ['line', 'M6 5.5h12a1 1 0 0 1 1 1V15H5V6.5a1 1 0 0 1 1-1z M3 18.5h18'],
    ],
  },
  devices: {
    box: '0 0 24 24',
    layers: [['line', 'M4 5.5h11v9H4z M7.5 18.5h4 M9.5 14.5v4 M18 8.5h2v10h-6']],
  },
  gear: {
    box: '0 0 24 24',
    layers: [
      [
        'line',
        'M12 3.5l1 .2.8 2.1a6.7 6.7 0 0 1 1.6.9l2.1-.8 1.5 1.5-.8 2.1c.4.5.7 1 .9 1.6l2.1.8v2.1l-2.1.8a6.7 6.7 0 0 1-.9 1.6l.8 2.1-1.5 1.5-2.1-.8a6.7 6.7 0 0 1-1.6.9l-.8 2.1h-2.1l-.8-2.1a6.7 6.7 0 0 1-1.6-.9l-2.1.8-1.5-1.5.8-2.1a6.7 6.7 0 0 1-.9-1.6l-2.1-.8v-2.1l2.1-.8a6.7 6.7 0 0 1 .9-1.6l-.8-2.1 1.5-1.5 2.1.8a6.7 6.7 0 0 1 1.6-.9l.8-2.1z M12 13m-2.7 0a2.7 2.7 0 1 0 5.4 0a2.7 2.7 0 1 0-5.4 0',
      ],
    ],
  },
  pencil: {
    box: '0 0 24 24',
    layers: [
      ['fill', 'M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z'],
      ['line', 'M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z M14.5 6.5l3 3'],
    ],
  },
  'pen-line': {
    box: '0 0 24 24',
    layers: [['line', 'M5 18.5h14 M7 15.5l1-3 7.5-7.5a1.8 1.8 0 0 1 2.5 2.5L10.5 15l-3 .5z']],
  },
  arrow: { box: '0 0 24 24', layers: [['line', 'M5 12h14 M13 6l6 6-6 6']] },
  chevron: { box: '0 0 24 24', layers: [['line', 'M9 6l6 6-6 6']] },
  up: { box: '0 0 24 24', layers: [['line', 'M6 15l6-6 6 6']] },
  down: { box: '0 0 24 24', layers: [['line', 'M6 9l6 6 6-6']] },
  grip: {
    box: '0 0 24 24',
    layers: [
      [
        'solid',
        'M9 6m-1.3 0a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0 M15 6m-1.3 0a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0 M9 12m-1.3 0a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0 M15 12m-1.3 0a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0 M9 18m-1.3 0a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0 M15 18m-1.3 0a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0',
      ],
    ],
  },
  // Cenas da saudação: nascer do sol, sol alto e lua com estrelas.
  morning: {
    box: '0 0 96 64',
    layers: [
      ['fill', 'M30 46a18 18 0 0 1 36 0z'],
      [
        'line',
        'M30 46a18 18 0 0 1 36 0 M14 46h68 M48 14v6 M25 23l4 4 M71 23l-4 4 M12 34l5 2 M84 34l-5 2',
      ],
      ['line', 'M30 54h36 M38 60h20'],
    ],
  },
  afternoon: {
    box: '0 0 96 64',
    layers: [
      ['fill', 'M48 32m-13 0a13 13 0 1 0 26 0a13 13 0 1 0-26 0'],
      [
        'line',
        'M48 32m-13 0a13 13 0 1 0 26 0a13 13 0 1 0-26 0 M48 8v7 M48 49v7 M24 32h7 M65 32h7 M31 15l5 5 M60 44l5 5 M65 15l-5 5 M36 44l-5 5',
      ],
    ],
  },
  evening: {
    box: '0 0 96 64',
    layers: [
      ['fill', 'M60 40A22 22 0 1 1 40 12a17 17 0 0 0 20 28z'],
      ['line', 'M60 40A22 22 0 1 1 40 12a17 17 0 0 0 20 28z'],
      [
        'solid',
        'M74 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M84 34m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M16 44m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M80 52m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
      ],
    ],
  },
  // Estado vazio: três ladrilhos tracejados, um deles com um mais.
  empty: {
    box: '0 0 96 64',
    layers: [
      ['fill', 'M16 14h28a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4z'],
      [
        'line',
        'M16 14h28a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4z M56 14h24a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H56a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4z M16 42h28a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4v-8a4 4 0 0 1 4-4z',
      ],
      ['line', 'M68 42v16 M60 50h16'],
    ],
  },
} as const satisfies Record<string, GlyphDefinition>;

export type HomeGlyphName = keyof typeof GLYPHS;

/** Desenho de cada ícone do catálogo de módulos; um nome novo no catálogo obriga a desenhar o ícone aqui. */
const MODULE_GLYPHS: Record<ModuleIconName, HomeGlyphName> = {
  tv: 'tv',
  activity: 'dumbbell',
  launcher: 'launcher',
  health: 'health',
  monitor: 'monitor',
  network: 'network',
  backup: 'backup',
  bell: 'bell',
  desktop: 'desktop',
};

export function moduleGlyph(icon: ModuleIconName): HomeGlyphName {
  return MODULE_GLYPHS[icon];
}

/** Desenho decorativo da Início: o texto vizinho é que informa; por isso fica oculto para leitores de tela. */
@Component({
  selector: 'app-home-glyph',
  template: `
    <svg [attr.viewBox]="definition().box" aria-hidden="true" focusable="false">
      @for (layer of definition().layers; track $index) {
        <path [attr.d]="layer[1]" [class]="layer[0]" />
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
      fill-opacity: 0.18;
      stroke: none;
    }
    path.solid {
      fill: currentColor;
      stroke: none;
    }
  `,
})
export class HomeGlyph {
  readonly name = input.required<HomeGlyphName>();

  protected readonly definition = computed<GlyphDefinition>(() => GLYPHS[this.name()]);
}
