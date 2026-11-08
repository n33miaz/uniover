import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
} from '@angular/core';
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
          <button
            type="button"
            class="pill"
            [attr.aria-label]="releaseLabel(mod)"
            (click)="release(mod)"
          >
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
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  /** Para onde o foco vai quando a última pílula some (o título da folha ou da aba): sem isto o foco se perderia. */
  readonly fallback = input<HTMLElement | null>(null);
  protected readonly list = computed(() =>
    PC_MODIFIERS.filter((modifier) => this.armed.armed().has(modifier)),
  );

  protected label(modifier: PcModifier): string {
    return MODIFIER_LABEL[modifier];
  }

  protected releaseLabel(modifier: PcModifier): string {
    const name = MODIFIER_LABEL[modifier];
    return $localize`:@@pc.armed.release:Soltar ${name}:name:`;
  }

  /** Solta a tecla e leva o foco à pílula seguinte (ou à anterior); sem pílulas, ao título. */
  protected release(modifier: PcModifier): void {
    const index = this.list().indexOf(modifier);
    tick();
    this.armed.toggle(modifier);
    afterNextRender(
      () => {
        const pills = [...this.host.nativeElement.querySelectorAll<HTMLElement>('.pill')];
        const next = pills[Math.min(index, pills.length - 1)];
        (next ?? this.fallback())?.focus();
      },
      { injector: this.injector },
    );
  }
}
