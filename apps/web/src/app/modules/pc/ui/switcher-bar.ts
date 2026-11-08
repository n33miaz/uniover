import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { PcSwitcher } from '../data/pc-switcher';
import { tick } from '../input/haptics';

/**
 * A barra do "Trocar janela": aparece enquanto o Alt está segurado, em qualquer aba do módulo (a casca a põe), e some quando ele
 * é solto. Anterior e Próxima dão Shift+Tab e Tab; Soltar solta o Alt, e o Windows troca para a janela escolhida. O estado vem
 * do store: se o PC some, a conta muda ou a página se esconde, o Alt é solto e a barra some sozinha.
 */
@Component({
  selector: 'app-pc-switcher-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (switcher.active()) {
      <div
        class="bar"
        role="group"
        aria-label="Trocando de janela"
        i18n-aria-label="@@pc.switch.label"
      >
        <span class="state" role="status">
          <span class="held">{{ altText }}</span>
          <span i18n="@@pc.switch.held">segurado</span>
        </span>
        <button
          type="button"
          class="step"
          [attr.data-switch]="'previous'"
          [disabled]="switcher.releasing()"
          (click)="previous()"
        >
          <span aria-hidden="true">←</span>
          <span i18n="@@pc.switch.previous">Anterior</span>
        </button>
        <button
          type="button"
          class="step"
          [attr.data-switch]="'next'"
          [disabled]="switcher.releasing()"
          (click)="next()"
        >
          <span i18n="@@pc.switch.next">Próxima</span>
          <span aria-hidden="true">→</span>
        </button>
        <button
          type="button"
          class="release"
          [attr.data-switch]="'release'"
          [disabled]="switcher.releasing()"
          (click)="release()"
        >
          <span i18n="@@pc.switch.release">Soltar</span>
        </button>
      </div>
    }
  `,
  styleUrl: './switcher-bar.css',
})
export class PcSwitcherBar {
  protected readonly switcher = inject(PcSwitcher);
  /** O nome da tecla não se traduz: é o que está no teclado do PC. */
  protected readonly altText = 'Alt';

  protected next(): void {
    tick();
    this.switcher.next();
  }

  protected previous(): void {
    tick();
    this.switcher.previous();
  }

  protected release(): void {
    tick();
    void this.switcher.release();
  }
}
