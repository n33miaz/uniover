import { Component, computed, input } from '@angular/core';
import { ModuleIconName } from '../../core/modules/module-registry';
import { HomeGlyph, moduleGlyph } from './home-glyph';

/** Uma peça do desenho: `line` é traço, `solid` é mancha cheia; a espessura padrão do traço é a da peça. */
interface IconPart {
  readonly kind: 'line' | 'solid';
  readonly d: string;
  readonly width?: number;
}

interface AppIconDefinition {
  readonly transform?: string;
  readonly parts: readonly IconPart[];
}

// Os mesmos desenhos de `design/icons/tv.svg`, `treino.svg`, `pc.svg` e `compras.svg` (grade de 512), só com caminhos: o desenho vem de
// dados, sem atributo solto no modelo. O fundo quadrado fica por conta do próprio componente.
const APP_ICONS: Partial<Record<ModuleIconName, AppIconDefinition>> = {
  tv: {
    transform: 'translate(-8 -22) rotate(26 256 300)',
    parts: [
      {
        kind: 'line',
        d: 'M228 204H284A42 42 0 0 1 326 246V406A42 42 0 0 1 284 448H228A42 42 0 0 1 186 406V246A42 42 0 0 1 228 204Z',
      },
      { kind: 'line', d: 'M224 282a32 32 0 1 0 64 0a32 32 0 1 0 -64 0Z', width: 18 },
      { kind: 'solid', d: 'M244 282a12 12 0 1 0 24 0a12 12 0 1 0 -24 0Z' },
      { kind: 'solid', d: 'M242 374a14 14 0 1 0 28 0a14 14 0 1 0 -28 0Z' },
      { kind: 'line', d: 'M228.91 143.33A44 44 0 0 1 283.09 143.33', width: 20 },
      { kind: 'line', d: 'M201.82 108.66A88 88 0 0 1 310.18 108.66', width: 20 },
    ],
  },
  activity: {
    transform: 'translate(0 3)',
    parts: [
      { kind: 'line', d: 'M81 228V284' },
      {
        kind: 'solid',
        d: 'M124 176H140A16 16 0 0 1 156 192V320A16 16 0 0 1 140 336H124A16 16 0 0 1 108 320V192A16 16 0 0 1 124 176Z',
      },
      {
        kind: 'solid',
        d: 'M372 176H388A16 16 0 0 1 404 192V320A16 16 0 0 1 388 336H372A16 16 0 0 1 356 320V192A16 16 0 0 1 372 176Z',
      },
      { kind: 'line', d: 'M431 228V284' },
      { kind: 'line', d: 'M156 256H196L222 320L262 184L290 256H356' },
    ],
  },
  desktop: {
    transform: 'translate(0 -6)',
    parts: [
      {
        kind: 'line',
        d: 'M126 128H386A30 30 0 0 1 416 158V314A30 30 0 0 1 386 344H126A30 30 0 0 1 96 314V158A30 30 0 0 1 126 128Z',
      },
      { kind: 'line', d: 'M256 344V396' },
      { kind: 'line', d: 'M186 396H326' },
      { kind: 'solid', d: 'M188 166L324 228L266 249L243 306Z' },
    ],
  },
  bag: {
    parts: [
      { kind: 'line', d: 'M136 192H376L356 408A28 28 0 0 1 328 434H184A28 28 0 0 1 156 408Z' },
      { kind: 'line', d: 'M200 236V164A56 56 0 0 1 312 164V236' },
      { kind: 'solid', d: 'M188 236a12 12 0 1 0 24 0a12 12 0 1 0 -24 0Z' },
      { kind: 'solid', d: 'M300 236a12 12 0 1 0 24 0a12 12 0 1 0 -24 0Z' },
    ],
  },
};

/** Ícone dos módulos na Início: os que já abrem preservam os desenhos próprios dos seus apps. */
@Component({
  selector: 'app-module-app-icon',
  imports: [HomeGlyph],
  host: { '[class.planned]': 'planned()' },
  template: `
    @if (definition(); as def) {
      <svg viewBox="0 0 512 512" aria-hidden="true" focusable="false">
        <g [attr.transform]="def.transform ?? null">
          @for (part of def.parts; track $index) {
            <path [attr.d]="part.d" [attr.stroke-width]="part.width ?? 26" [class]="part.kind" />
          }
        </g>
      </svg>
    } @else {
      <app-home-glyph [name]="glyph()" />
    }
  `,
  styles: `
    /*
     * Os módulos que já existem usam a cor da marca; os planejados ficam em verde-cinza discreto. No escuro o verde claro
     * é bom para texto, mas não para o desenho branco dentro do ícone: o fundo escurece. Mesma guarda da paleta do
     * styles.css (o tema fixado no app vale mais que o do sistema), aqui e não lá para não pesar no pacote inicial.
     */
    :host {
      --a-module-app: var(--a-accent);
      --a-module-app-planned: color-mix(in srgb, var(--a-ink2) 88%, var(--a-elev));
      display: inline-flex;
      flex: none;
      width: var(--module-icon-size, 56px);
      height: var(--module-icon-size, 56px);
      overflow: hidden;
      border-radius: var(--module-icon-radius, var(--radius-sm));
      background: var(--a-module-app);
      color: var(--a-on-module-app, #fff);
    }

    :host(.planned) {
      background: var(--a-module-app-planned);
    }

    @media (prefers-color-scheme: dark) {
      :host-context(:root:not([data-theme='light'])) {
        --a-module-app: color-mix(in srgb, var(--a-accent) 30%, var(--a-bg));
        --a-module-app-planned: color-mix(in srgb, var(--a-ink2) 22%, var(--a-elev));
      }
    }

    :host-context(:root[data-theme='dark']) {
      --a-module-app: color-mix(in srgb, var(--a-accent) 30%, var(--a-bg));
      --a-module-app-planned: color-mix(in srgb, var(--a-ink2) 22%, var(--a-elev));
    }

    svg,
    app-home-glyph {
      width: 100%;
      height: 100%;
    }

    app-home-glyph {
      --glyph-size: 100%;
      /* Proporcional ao quadrado: o glifo ocupa a mesma fração em 36 px (Personalizar) e em 80 px (cartões da Início). */
      padding: 14%;
    }

    .line {
      fill: none;
      stroke: var(--a-on-module-app, #fff);
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .solid {
      fill: var(--a-on-module-app, #fff);
      stroke: none;
    }
  `,
})
export class ModuleAppIcon {
  readonly icon = input.required<ModuleIconName>();
  /** Módulo ainda sem tela ("Em Breve"): o fundo fica em verde-cinza em vez da cor da marca. */
  readonly planned = input(false);

  protected readonly definition = computed(() => APP_ICONS[this.icon()]);
  protected readonly glyph = computed(() => moduleGlyph(this.icon()));
}
