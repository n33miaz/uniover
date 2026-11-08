import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { PcShortcutGrid } from '../ui/shortcut-grid';

/**
 * A aba Atalhos: o catálogo inteiro, agrupado, na própria tela (a folha do ⚡ mostra o mesmo, sobre o mouse). O lápis liga o
 * modo de edição: tocar fixa ou solta o atalho em "Fixados". Sem texto explicativo.
 */
@Component({
  selector: 'app-pc-shortcuts-page',
  imports: [PcShortcutGrid],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="head">
      <h2 i18n="@@pc.sc.title">Atalhos</h2>
      <button
        type="button"
        class="icon"
        [class.on]="editing()"
        [attr.aria-pressed]="editing()"
        aria-label="Editar fixados"
        i18n-aria-label="@@pc.sc.edit"
        (click)="editing.set(!editing())"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4'" />
        </svg>
      </button>
    </header>
    <app-pc-shortcut-grid [editing]="editing()" />
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .head {
      display: flex;
      align-items: center;
      gap: var(--space-1);
    }
    h2 {
      flex: 1;
      margin: 0;
      font-size: var(--fs-title);
    }
    .icon {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: var(--a-ink2);
      cursor: pointer;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    .icon.on {
      background: var(--a-accent-soft);
      color: var(--a-accent-ink);
      box-shadow: inset 0 0 0 1.5px var(--a-accent);
    }
    .icon:focus-visible {
      outline: 3px solid var(--a-accent);
      outline-offset: 2px;
    }
    .icon svg {
      width: 22px;
      height: 22px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
  `,
})
export class ShortcutsPage {
  protected readonly editing = signal(false);
}
