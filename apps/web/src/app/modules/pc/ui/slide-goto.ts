import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { PcInput } from '../data/pc-input';
import { parseSlideNumber } from '../data/pc-slides';
import { PcStore } from '../data/pc-store';

/**
 * "Ir ao slide N": o número e o botão, numa linha. Manda os dígitos e o Enter (o que o PowerPoint e os leitores de PDF
 * entendem). Os dígitos só a `pc.key.v2` traz, então num PC que não a declarou a linha nem aparece.
 */
@Component({
  selector: 'app-pc-slide-goto',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.supportsKeyV2()) {
      <form class="goto" novalidate (submit)="goto($event, slide)">
        <input
          #slide
          class="goto-input"
          type="text"
          aria-label="Número do slide"
          i18n-aria-label="@@pc.sc.goto-label"
          placeholder="Nº"
          i18n-placeholder="@@pc.slides.goto-placeholder"
          [attr.inputmode]="'numeric'"
          pattern="[0-9]*"
          maxlength="3"
          autocomplete="off"
          [disabled]="!store.canSend()"
        />
        <button type="submit" class="goto-go" [disabled]="!store.canSend()">
          <span i18n="@@pc.slides.goto-go">Ir ao Slide</span>
        </button>
      </form>
      @if (note(); as message) {
        <p class="note" role="alert">{{ message }}</p>
      }
    }
  `,
  styleUrl: './slide-goto.css',
})
export class PcSlideGoto {
  protected readonly store = inject(PcStore);
  private readonly input = inject(PcInput);
  protected readonly note = signal<string | null>(null);

  protected goto(event: Event, field: HTMLInputElement): void {
    event.preventDefault();
    if (!this.store.canSend()) return;
    const slide = parseSlideNumber(field.value);
    if (slide === null) {
      this.note.set($localize`:@@pc.sc.goto-invalid:Digite o número do slide, de 1 a 999.`);
      return;
    }
    this.note.set(null);
    this.input.gotoSlide(slide);
    field.value = '';
  }
}
