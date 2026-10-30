import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Barra superior para as páginas dos módulos. Mantém o título no centro real reservando um lado de 44 px mesmo quando
 * não há ação; os círculos seguem o mesmo visual do controle de TV. As telas existentes podem adotá-la aos poucos.
 */
@Component({
  selector: 'app-page-top-bar',
  template: `
    <header class="head">
      <div class="lead">
        @if (backLabel()) {
          <button
            type="button"
            class="circle back"
            [attr.aria-label]="backLabel()"
            (click)="back.emit()"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path [attr.d]="'M19 12H5'" />
              <path [attr.d]="'M11 18l-6-6 6-6'" />
            </svg>
          </button>
        }
      </div>
      <div class="name">
        <h1>{{ title() }}</h1>
      </div>
      <div class="actions"><ng-content select="[pageTopBarActions]" /></div>
    </header>
  `,
  styles: `
    :host {
      display: block;
    }
    .head {
      --gap: 6px;
      --side: var(--tap);
      display: grid;
      grid-template-columns: minmax(var(--side), 1fr) minmax(0, auto) minmax(var(--side), 1fr);
      column-gap: 4px;
      align-items: center;
      min-height: calc(var(--tap) + var(--space-3) + env(safe-area-inset-top));
      /* O respiro de cima que o controle da TV também tem: os botões não encostam na borda da tela. */
      padding: calc(var(--space-3) + env(safe-area-inset-top))
        max(var(--gutter), env(safe-area-inset-right)) 0
        max(var(--gutter), env(safe-area-inset-left));
      background: transparent;
    }
    .lead,
    .actions {
      display: flex;
      align-items: center;
      min-width: 0;
    }
    .lead {
      justify-self: start;
    }
    .actions {
      justify-self: end;
    }
    .circle {
      display: grid;
      place-items: center;
      width: var(--tap);
      height: var(--tap);
      padding: 0;
      border: 1px solid var(--a-line);
      border-radius: 50%;
      background: var(--a-surface);
      color: var(--a-ink);
      font: inherit;
      text-decoration: none;
      cursor: pointer;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    .circle:disabled {
      opacity: 0.4;
      cursor: default;
    }
    @media (hover: hover) {
      .circle:not(:disabled):hover {
        border-color: var(--a-accent);
      }
    }
    .circle:focus-visible {
      outline: 3px solid var(--a-accent);
      outline-offset: 2px;
    }
    .circle svg {
      width: 22px;
      height: 22px;
    }
    :host ::ng-deep [pageTopBarActions] {
      display: grid;
      place-items: center;
      width: var(--tap);
      height: var(--tap);
      padding: 0;
      border: 1px solid var(--a-line);
      border-radius: 50%;
      background: var(--a-surface);
      color: var(--a-ink);
      font: inherit;
      text-decoration: none;
      cursor: pointer;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    /* A pílula: vários controles no mesmo contorno (cada um com o seu alvo de 44 px); sozinho, um só vira o círculo. */
    :host ::ng-deep [pageTopBarActions].pill {
      display: flex;
      width: auto;
      min-width: var(--tap);
      border-radius: calc(var(--tap) / 2);
    }
    :host ::ng-deep [pageTopBarActions]:focus-visible {
      outline: 3px solid var(--a-accent);
      outline-offset: 2px;
    }
    @media (hover: hover) {
      :host ::ng-deep [pageTopBarActions]:hover {
        border-color: var(--a-accent);
      }
    }
    .name {
      min-width: 0;
      justify-self: center;
    }
    /* O título recebe foco só por código (anúncio ao trocar de tela): não é controle, então sem anel. */
    h1:focus {
      outline: none;
    }
    h1 {
      margin: 0;
      min-width: 0;
      overflow: hidden;
      font-size: 1.35rem;
      text-align: center;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PageTopBar {
  readonly title = input.required<string>();
  readonly backLabel = input<string | null>(null);
  readonly back = output<void>();
}
