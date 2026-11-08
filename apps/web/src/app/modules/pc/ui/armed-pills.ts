import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { PcArmed } from '../data/pc-armed';
import { PC_MODIFIERS, type PcModifier } from '../data/pc-types';
import { tick } from '../input/haptics';

/** Os nomes das teclas modificadoras não se traduzem: são as que estão no teclado do PC. */
const MODIFIER_LABEL: Readonly<Record<PcModifier, string>> = {
  CTRL: 'Ctrl',
  SHIFT: 'Shift',
  ALT: 'Alt',
  WIN: 'Win',
};

/**
 * As teclas armadas à vista, onde quer que um atalho possa ser tocado (a aba Atalhos e a folha do raio): quem armou Win na
 * tela do mouse e tocou em "Procurar" precisa ver que vai sair Win+Ctrl+F. Cada pílula, tocada, solta a tecla. Sem nenhuma
 * armada, nada aparece.
 */
@Component({
  selector: 'app-pc-armed-pills',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (list().length > 0) {
      <div
        class="pills"
        role="group"
        aria-label="Teclas armadas"
        i18n-aria-label="@@pc.keyboard.modifiers"
      >
        @for (mod of list(); track mod) {
          <button type="button" class="pill" aria-pressed="true" (click)="release(mod)">
            {{ label(mod) }}
          </button>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
    .pills {
      display: flex;
      gap: var(--space-1);
    }
    .pill {
      min-width: var(--tap);
      min-height: var(--tap);
      padding: 0 var(--space-3);
      border: 1px solid var(--a-accent);
      border-radius: var(--radius-pill);
      background: var(--a-accent-soft);
      color: var(--a-accent-ink);
      font: inherit;
      font-size: var(--fs-small);
      font-weight: 650;
      cursor: pointer;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    .pill:focus-visible {
      outline: 3px solid var(--a-accent);
      outline-offset: 2px;
    }
  `,
})
export class PcArmedPills {
  private readonly armed = inject(PcArmed);
  protected readonly list = computed(() =>
    PC_MODIFIERS.filter((modifier) => this.armed.armed().has(modifier)),
  );

  protected label(modifier: PcModifier): string {
    return MODIFIER_LABEL[modifier];
  }

  protected release(modifier: PcModifier): void {
    tick();
    this.armed.toggle(modifier);
  }
}
