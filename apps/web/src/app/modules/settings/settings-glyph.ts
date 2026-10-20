import { Component, computed, input } from '@angular/core';
import { ModuleIconName } from '../../core/modules/module-registry';

/**
 * Camadas de um desenho: `line` é o contorno, `fill` é a mancha suave por trás (a mesma cor com pouca opacidade),
 * `solid` é um detalhe cheio.
 */
type Layer = 'line' | 'fill' | 'solid';

interface GlyphDefinition {
  readonly layers: readonly (readonly [Layer, string])[];
}

// Desenhos próprios do app, em grade de 24. Só caminhos: o desenho inteiro vem de dados, sem atributo solto no
// modelo.
const GLYPHS = {
  user: {
    layers: [
      ['fill', 'M12 12.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
      ['line', 'M12 12.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4.5 20.5a7.5 7.5 0 0 1 15 0'],
    ],
  },
  users: {
    layers: [
      ['fill', 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z'],
      [
        'line',
        'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M2.5 20a6.5 6.5 0 0 1 13 0 M15.8 4.7a3.5 3.5 0 0 1 0 6.6 M18 13.8a6.5 6.5 0 0 1 3.5 6.2',
      ],
    ],
  },
  shield: {
    layers: [
      ['fill', 'M12 3l7 2.8v5.6c0 4.3-2.9 7.8-7 9.6-4.1-1.8-7-5.3-7-9.6V5.8z'],
      [
        'line',
        'M12 3l7 2.8v5.6c0 4.3-2.9 7.8-7 9.6-4.1-1.8-7-5.3-7-9.6V5.8z M9 12l2.2 2.2L15.5 10',
      ],
    ],
  },
  key: {
    layers: [
      ['fill', 'M8 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
      ['line', 'M8 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 11h8.5 M17.5 11v3.2 M20.5 11v2.2'],
    ],
  },
  grid: {
    layers: [
      ['fill', 'M4 4h6.5v6.5H4z M13.5 13.5H20V20h-6.5z'],
      ['line', 'M4 4h6.5v6.5H4z M13.5 4H20v6.5h-6.5z M4 13.5h6.5V20H4z M13.5 13.5H20V20h-6.5z'],
    ],
  },
  tv: {
    layers: [
      ['fill', 'M5 5h14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z'],
      ['line', 'M5 5h14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z'],
      ['line', 'M8.5 21h7 M12 17.5V21'],
      ['solid', 'M10.4 8.6l4.2 2.4-4.2 2.4z'],
    ],
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
  laptop: {
    layers: [
      ['fill', 'M6 5.5h12a1 1 0 0 1 1 1V15H5V6.5a1 1 0 0 1 1-1z'],
      ['line', 'M6 5.5h12a1 1 0 0 1 1 1V15H5V6.5a1 1 0 0 1 1-1z M3 18.5h18'],
    ],
  },
  sun: {
    layers: [
      ['fill', 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z'],
      [
        'line',
        'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z M12 2.5v2 M12 19.5v2 M2.5 12h2 M19.5 12h2 M5.3 5.3l1.4 1.4 M17.3 17.3l1.4 1.4 M18.7 5.3l-1.4 1.4 M6.7 17.3l-1.4 1.4',
      ],
    ],
  },
  moon: {
    layers: [
      ['fill', 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'],
      ['line', 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'],
    ],
  },
  contrast: {
    layers: [
      ['line', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
      ['solid', 'M12 3a9 9 0 0 1 0 18z'],
    ],
  },
  info: {
    layers: [
      ['fill', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
      ['line', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v5.5 M12 7.7h.01'],
    ],
  },
  heart: {
    layers: [
      ['fill', 'M12 20s-7-4.4-7-10a4.2 4.2 0 0 1 7-3 4.2 4.2 0 0 1 7 3c0 5.6-7 10-7 10z'],
      ['line', 'M12 20s-7-4.4-7-10a4.2 4.2 0 0 1 7-3 4.2 4.2 0 0 1 7 3c0 5.6-7 10-7 10z'],
    ],
  },
  logout: {
    layers: [['line', 'M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4 M15 8l4 4-4 4 M19 12H9']],
  },
  chevron: { layers: [['line', 'M9 6l6 6-6 6']] },
  check: { layers: [['line', 'M5 12.5l4.5 4.5L19 7.5']] },
  checkCircle: {
    layers: [
      ['fill', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
      ['line', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M8 12.3l2.7 2.7L16 9.5'],
    ],
  },
  clock: {
    layers: [
      ['fill', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
      ['line', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7.2V12l3.2 2'],
    ],
  },
  alert: {
    layers: [
      ['fill', 'M12 4l9 16H3z'],
      ['line', 'M12 4l9 16H3z M12 10v4 M12 17.2h.01'],
    ],
  },
  plus: { layers: [['line', 'M12 5v14 M5 12h14']] },
  pencil: {
    layers: [
      ['fill', 'M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z'],
      ['line', 'M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z M14.5 6.5l3 3'],
    ],
  },
  trash: { layers: [['line', 'M5 7h14 M10 7V4.5h4V7 M7 7l1 13h8l1-13']] },
  copy: {
    layers: [
      ['fill', 'M9 9h10v11H9z'],
      ['line', 'M9 9h10v11H9z M5 15V4h10'],
    ],
  },
  share: { layers: [['line', 'M12 15V4 M8 8l4-4 4 4 M5 12v7h14v-7']] },
  mail: {
    layers: [
      ['fill', 'M4 6.5h16v11H4z'],
      ['line', 'M4 6.5h16v11H4z M4.5 7.5l7.5 6 7.5-6'],
    ],
  },
  link: {
    layers: [
      [
        'line',
        'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
      ],
    ],
  },
} as const satisfies Record<string, GlyphDefinition>;

export type SettingsGlyphName = keyof typeof GLYPHS;

/** Desenho de cada ícone do catálogo de módulos; um nome novo no catálogo obriga a desenhar o ícone aqui. */
const MODULE_GLYPHS: Record<ModuleIconName, SettingsGlyphName> = {
  tv: 'tv',
  activity: 'dumbbell',
};

export function moduleGlyph(icon: ModuleIconName): SettingsGlyphName {
  return MODULE_GLYPHS[icon];
}

/** Desenho decorativo dos Ajustes: o texto vizinho é que informa; por isso fica oculto para leitores de tela. */
@Component({
  selector: 'app-settings-glyph',
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
export class SettingsGlyph {
  readonly name = input.required<SettingsGlyphName>();

  protected readonly layers = computed<GlyphDefinition['layers']>(() => GLYPHS[this.name()].layers);
}
