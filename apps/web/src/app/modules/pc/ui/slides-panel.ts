import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { PcInput } from '../data/pc-input';
import { PcStore } from '../data/pc-store';
import { PcShortcutCells } from './shortcut-cells';
import { PcSlideGoto } from './slide-goto';
import { PcSlideTimer } from './slide-timer';

/** Quanto o dedo precisa andar para os lados para valer como deslizar, e o quanto de vertical ele pode andar. */
export const SWIPE_MIN_PX = 48;
export const SWIPE_MAX_SLOPE = 0.7;

/**
 * A apresentação: anterior e próximo ocupando a tela (metade cada; deslizar para os lados também vale), iniciar, encerrar e
 * tela preta ou branca, "ir ao slide" e um cronômetro local. As teclas são as do catálogo (seta, F5, Esc, B, W: as que o
 * PowerPoint, o Google Apresentações e os leitores de PDF entendem); "ir ao slide" usa os dígitos e precisa de `pc.key.v2`.
 * Nada aqui lê o PC: nem miniaturas, nem notas.
 */
@Component({
  selector: 'app-pc-slides-panel',
  imports: [PcShortcutCells, PcSlideGoto, PcSlideTimer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="nav"
      (pointerdown)="swipeStart($event)"
      (pointerup)="swipeEnd($event)"
      (pointercancel)="swipeCancel()"
    >
      <button
        type="button"
        class="half"
        [attr.data-action]="'previous'"
        [disabled]="!store.canSend()"
        (click)="go('slides-previous')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="'M15 5l-7 7 7 7'" /></svg>
        <span i18n="@@pc.slides.previous">Anterior</span>
      </button>
      <button
        type="button"
        class="half next"
        [attr.data-action]="'next'"
        [disabled]="!store.canSend()"
        (click)="go('slides-next')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="'M9 5l7 7-7 7'" /></svg>
        <span i18n="@@pc.slides.next">Próximo</span>
      </button>
    </div>
    <app-pc-shortcut-cells [ids]="['slides-start', 'slides-here', 'slides-end']" />
    <app-pc-shortcut-cells [ids]="['slides-black', 'slides-white']" [columns]="2" />
    <app-pc-slide-goto />
    <app-pc-slide-timer />
  `,
  styleUrl: './slides-panel.css',
})
export class PcSlidesPanel {
  protected readonly store = inject(PcStore);
  private readonly input = inject(PcInput);

  private swipeFrom: { readonly id: number; readonly x: number; readonly y: number } | null = null;
  /** O último gesto foi um deslizar (já agiu): o clique que o navegador solta em seguida não age de novo. */
  private swiped = false;

  protected go(id: 'slides-previous' | 'slides-next'): void {
    if (this.swiped) {
      this.swiped = false;
      return;
    }
    this.input.plain(id === 'slides-next' ? 'RIGHT' : 'LEFT');
  }

  protected swipeStart(event: PointerEvent): void {
    this.swiped = false;
    this.swipeFrom = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  protected swipeEnd(event: PointerEvent): void {
    const from = this.swipeFrom;
    this.swipeFrom = null;
    if (!from || from.id !== event.pointerId) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dy) > Math.abs(dx) * SWIPE_MAX_SLOPE) return;
    this.swiped = true;
    // Deslizar para a esquerda traz o slide seguinte (como virar a página); para a direita, o anterior.
    this.input.plain(dx < 0 ? 'RIGHT' : 'LEFT');
  }

  protected swipeCancel(): void {
    this.swipeFrom = null;
  }
}
