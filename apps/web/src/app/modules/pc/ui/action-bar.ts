import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { PcArmed } from '../data/pc-armed';
import { PC_MODIFIERS, type PcKey, type PcModifier } from '../data/pc-types';
import { tick } from '../input/haptics';
import { PcRepeat } from './pc-repeat';

/** Os nomes das teclas modificadoras não se traduzem: são as que estão no teclado do PC. */
const MODIFIER_LABEL: Readonly<Record<PcModifier, string>> = {
  CTRL: 'Ctrl',
  SHIFT: 'Shift',
  ALT: 'Alt',
  WIN: 'Win',
};

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
    @if (typing()) {
      <!-- Com o teclado do celular aberto, as teclas armadas ficam aqui (o painel de teclas cobriria o campo). -->
      <div
        class="mods"
        role="group"
        aria-label="Teclas armadas"
        i18n-aria-label="@@pc.keyboard.modifiers"
      >
        @for (mod of modifiers; track mod) {
          <button
            type="button"
            class="key"
            [class.on]="armed.has(mod)"
            [attr.aria-pressed]="armed.has(mod)"
            [disabled]="disabled()"
            (click)="toggle(mod)"
          >
            {{ label(mod) }}
          </button>
        }
      </div>
    }
    <div class="bar" role="group" aria-label="Teclas rápidas" i18n-aria-label="@@pc.bar.label">
      <button
        type="button"
        class="key"
        [class.on]="typing()"
        [attr.aria-pressed]="typing()"
        [disabled]="disabled()"
        aria-label="Teclado"
        i18n-aria-label="@@pc.bar.keyboard"
        (pointerdown)="$event.preventDefault()"
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
        [batched]="batched()"
        (repeatMany)="keyRepeat.emit({ key: 'BACKSPACE', count: $event })"
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
        [disabled]="disabled() || panelDisabled()"
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
  protected readonly armed = inject(PcArmed);
  protected readonly modifiers = PC_MODIFIERS;

  /** Os nomes das teclas não se traduzem: são os que estão no teclado do PC. */
  protected readonly escapeText = 'Esc';
  protected readonly tabText = 'Tab';

  readonly disabled = input(false);
  /** O teclado do celular está aberto (a barra o mostra ligado). */
  readonly typing = input(false);
  readonly panelOpen = input(false);
  /** O painel não abre agora (a barra do "Trocar janela" ocupa o lugar dele). */
  readonly panelDisabled = input(false);
  readonly shortcutsOpen = input(false);
  /** Devolve `true` quando já há teclas demais sem resposta: a repetição de apagar pula a rodada. */
  readonly busy = input<() => boolean>(() => false);

  /** Segurar repete em lotes (`pc.key.v2`); sem isso, uma repetição por pedido, como sempre. */
  readonly batched = input(false);

  readonly key = output<PcKey>();
  /** Apagar segurado num PC que entende `pc.key.v2`: um pedido com `count` repetições. */
  readonly keyRepeat = output<{ readonly key: PcKey; readonly count: number }>();
  readonly keyboard = output<void>();

  protected label(modifier: PcModifier): string {
    return MODIFIER_LABEL[modifier];
  }

  protected toggle(modifier: PcModifier): void {
    tick();
    this.armed.toggle(modifier);
  }

  readonly panel = output<void>();
  readonly shortcuts = output<void>();
}
