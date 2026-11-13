import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PcPadSettingsSheet } from '../ui/pad-settings-sheet';

/**
 * Mais: uma linha larga por assunto, sem texto explicativo. Energia leva à tela dela (as confirmações continuam lá) e
 * Ajustes abre a folha de ajustes do mouse.
 */
@Component({
  selector: 'app-pc-more-page',
  imports: [RouterLink, PcPadSettingsSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="list">
      <li>
        <a class="row" routerLink="/pc/controles">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path [attr.d]="'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'" />
          </svg>
          <span i18n="@@pc.more.remotes">Controles</span>
          <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true">
            <path [attr.d]="'M9 6l6 6-6 6'" />
          </svg>
        </a>
      </li>
      <li>
        <a class="row" routerLink="/pc/energia">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path [attr.d]="'M12 3v8M7 6.5a8 8 0 1 0 10 0'" />
          </svg>
          <span i18n="@@pc.more.power">Energia</span>
          <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true">
            <path [attr.d]="'M9 6l6 6-6 6'" />
          </svg>
        </a>
      </li>
      <li>
        <button type="button" class="row" (click)="settingsOpen.set(true)">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path [attr.d]="'M4 7h9M17 7h3M4 17h3M11 17h9'" />
            <circle cx="15" cy="7" r="2" />
            <circle cx="9" cy="17" r="2" />
          </svg>
          <span i18n="@@pc.more.settings">Ajustes</span>
          <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true">
            <path [attr.d]="'M9 6l6 6-6 6'" />
          </svg>
        </button>
      </li>
    </ul>

    @if (settingsOpen()) {
      <app-pc-pad-settings-sheet (closed)="settingsOpen.set(false)" />
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      box-sizing: border-box;
      width: 100%;
      min-height: 60px;
      padding: 0 var(--space-4);
      border: 1px solid var(--a-line);
      border-radius: var(--radius);
      background: var(--a-surface);
      color: var(--a-ink);
      font: inherit;
      font-weight: 650;
      text-align: left;
      text-decoration: none;
      cursor: pointer;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    .row:active {
      background: var(--a-accent-soft);
    }
    .row:focus-visible {
      outline: 3px solid var(--a-accent);
      outline-offset: 2px;
    }
    .row span {
      flex: 1;
    }
    svg {
      width: 24px;
      height: 24px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .chevron {
      width: 20px;
      height: 20px;
      color: var(--a-ink3);
    }
  `,
})
export class MorePage {
  protected readonly settingsOpen = signal(false);
}
