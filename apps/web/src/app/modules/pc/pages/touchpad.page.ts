import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { PcStore } from '../data/pc-store';
import { tick } from '../input/haptics';
import { PadButton, PadGesture } from '../input/pad-gesture';

/**
 * Touchpad de toque: um dedo move o ponteiro (com aceleração), um toque clica, dois dedos rolam e um toque de dois dedos
 * clica com o botão direito. Embaixo, os botões esquerdo e direito e o "Arrastar", que segura o esquerdo até soltar. Para
 * quem usa teclado ou leitor de tela, a superfície explica o que faz e os botões fazem o mesmo que os toques.
 */
@Component({
  selector: 'app-pc-touchpad-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="pad"
      role="group"
      aria-labelledby="pad-help"
      [class.active]="active()"
      tabindex="0"
      (pointerdown)="onDown($event)"
      (pointermove)="onMove($event)"
      (pointerup)="onUp($event)"
      (pointercancel)="onCancel()"
      (contextmenu)="$event.preventDefault()"
      (keydown)="onKey($event)"
    >
      <span class="hint" aria-hidden="true" i18n="@@pc.pad.hint"
        >Deslize para mover · toque para clicar</span
      >
      <span class="hint second" aria-hidden="true" i18n="@@pc.pad.hint-scroll"
        >Dois dedos rolam</span
      >
    </div>
    <p id="pad-help" class="sr-only" i18n="@@pc.pad.help">
      Touchpad: deslize um dedo para mover o ponteiro do PC, toque para clicar, deslize dois dedos
      para rolar e toque com dois dedos para o botão direito. Use os botões abaixo se preferir.
    </p>

    <div class="buttons">
      <button
        type="button"
        class="ui-btn"
        [disabled]="!store.canSend()"
        (click)="press('LEFT')"
        i18n="@@pc.pad.left"
      >
        Esquerdo
      </button>
      <button
        type="button"
        class="ui-btn"
        [attr.aria-pressed]="store.dragging()"
        [class.on]="store.dragging()"
        [disabled]="!store.canSend()"
        (click)="drag()"
        i18n="@@pc.pad.drag"
      >
        Arrastar
      </button>
      <button
        type="button"
        class="ui-btn"
        [disabled]="!store.canSend()"
        (click)="press('RIGHT')"
        i18n="@@pc.pad.right"
      >
        Direito
      </button>
    </div>
  `,
  styleUrl: './touchpad.page.css',
})
export class TouchpadPage {
  protected readonly store = inject(PcStore);
  protected readonly active = signal(false);

  private readonly gesture = new PadGesture({
    move: (dx, dy, elapsedMs) => this.store.movePointer(dx, dy, elapsedMs),
    scroll: (dx, dy) => this.store.scrollPointer(dx, dy),
    tap: (button) => this.press(button),
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.gesture.cancel();
      // Largar a tela com o botão apertado deixaria o PC arrastando para sempre.
      if (this.store.dragging()) void this.store.toggleDrag();
    });
  }

  protected onDown(event: PointerEvent): void {
    if (!this.store.canSend()) return;
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    if (!this.gesture.active) this.store.beginGesture();
    this.active.set(true);
    this.gesture.down(event.pointerId, event.clientX, event.clientY, event.timeStamp);
  }

  protected onMove(event: PointerEvent): void {
    if (!this.active()) return;
    this.gesture.move(event.pointerId, event.clientX, event.clientY, event.timeStamp);
  }

  protected onUp(event: PointerEvent): void {
    if (!this.active()) return;
    this.gesture.up(event.pointerId, event.timeStamp);
    if (!this.gesture.active) this.finish();
  }

  /**
   * O sistema tomou o toque (uma rolagem do navegador, uma ligação). Não se escuta `lostpointercapture`: ele também chega
   * depois de cada dedo que sai, e cancelaria o segundo dedo no meio do toque de dois dedos.
   */
  protected onCancel(): void {
    this.gesture.cancel();
    this.finish();
  }

  /** Teclado: as setas movem de dez em dez pixels e Enter ou Espaço clicam. */
  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.press('LEFT');
      return;
    }
    const steps: Record<string, [number, number]> = {
      ArrowUp: [0, -10],
      ArrowDown: [0, 10],
      ArrowLeft: [-10, 0],
      ArrowRight: [10, 0],
    };
    const step = steps[event.key];
    if (step) {
      event.preventDefault();
      this.store.movePointer(step[0], step[1], 16);
      this.store.endGesture();
    }
  }

  protected press(button: PadButton): void {
    tick();
    void this.store.click(button);
  }

  protected drag(): void {
    tick();
    void this.store.toggleDrag();
  }

  private finish(): void {
    this.active.set(false);
    this.store.endGesture();
  }
}
