import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { PcKey } from '../data/pc-types';
import { PcRepeat } from './pc-repeat';

/**
 * A barra de ações da tela do mouse: sempre à vista, sem rolagem, a um toque do touchpad. Teclado do celular, Enter, apagar
 * (segurar repete), Esc, Tab, o painel de teclas e os atalhos. Só mostra e avisa: quem manda a tecla é a tela. Sem PC
 * conectado os botões ficam desenhados e desligados (a tela não "pula").
 */
@Component({
  selector: 'app-pc-action-bar',
  imports: [PcRepeat],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar" role="group" aria-label="Teclas rápidas" i18n-aria-label="@@pc.bar.label">
      <button
        type="button"
        class="key"
        [class.on]="typing()"
        [attr.aria-pressed]="typing()"
        [disabled]="disabled()"
        aria-label="Teclado"
        i18n-aria-label="@@pc.bar.keyboard"
        (click)="keyboard.emit()"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="2.5" y="6" width="19" height="12" rx="2" />
          <path [attr.d]="'M6.5 10h.01M10.5 10h.01M14 10h.01M17.5 10h.01M7.5 14h9'" />
        </svg>
      </button>
      <button
        type="button"
        class="key"
        [disabled]="disabled()"
        aria-label="Enter"
        i18n-aria-label="@@pc.key.enter"
        (click)="key.emit('ENTER')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M20 6v6a2 2 0 0 1-2 2H5M9 10l-4 4 4 4'" />
        </svg>
      </button>
      <button
        type="button"
        class="key"
        [disabled]="disabled()"
        aria-label="Apagar"
        i18n-aria-label="@@pc.key.backspace"
        (appPcRepeat)="key.emit('BACKSPACE')"
        [repeatSkip]="busy()"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            [attr.d]="'M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7zM12.5 9.5l5 5M17.5 9.5l-5 5'"
          />
        </svg>
      </button>
      <button
        type="button"
        class="key"
        [disabled]="disabled()"
        aria-label="Esc (Escape)"
        i18n-aria-label="@@pc.key.escape"
        (click)="key.emit('ESCAPE')"
      >
        {{ escapeText }}
      </button>
      <button
        type="button"
        class="key"
        [disabled]="disabled()"
        aria-label="Tab"
        i18n-aria-label="@@pc.key.tab"
        (click)="key.emit('TAB')"
      >
        {{ tabText }}
      </button>
      <button
        type="button"
        class="key"
        [class.on]="panelOpen()"
        [attr.aria-expanded]="panelOpen()"
        [disabled]="disabled()"
        aria-label="Mais teclas"
        i18n-aria-label="@@pc.bar.more-keys"
        (click)="panel.emit()"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            [attr.d]="'M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5'"
          />
        </svg>
      </button>
      <button
        type="button"
        class="key"
        [class.on]="shortcutsOpen()"
        [attr.aria-expanded]="shortcutsOpen()"
        [disabled]="disabled()"
        aria-label="Atalhos"
        i18n-aria-label="@@pc.bar.shortcuts"
        (click)="shortcuts.emit()"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M13 3 5 13.5h6L10 21l8-10.5h-6z'" />
        </svg>
      </button>
    </div>
  `,
  styleUrls: ['./key-button.css', './action-bar.css'],
})
export class PcActionBar {
  /** Os nomes das teclas não se traduzem: são os que estão no teclado do PC. */
  protected readonly escapeText = 'Esc';
  protected readonly tabText = 'Tab';

  readonly disabled = input(false);
  /** O teclado do celular está aberto (a barra o mostra ligado). */
  readonly typing = input(false);
  readonly panelOpen = input(false);
  readonly shortcutsOpen = input(false);
  /** Devolve `true` quando já há teclas demais sem resposta: a repetição de apagar pula a rodada. */
  readonly busy = input<() => boolean>(() => false);

  readonly key = output<PcKey>();
  readonly keyboard = output<void>();
  readonly panel = output<void>();
  readonly shortcuts = output<void>();
}
