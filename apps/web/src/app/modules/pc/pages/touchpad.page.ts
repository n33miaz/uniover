import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { PcStore } from '../data/pc-store';
import { PcPadSettingsSheet } from '../ui/pad-settings-sheet';
import { tick } from '../input/haptics';
import { PadButton, PadGesture } from '../input/pad-gesture';

/**
 * Touchpad de toque: um dedo move o ponteiro, um toque clica, um dedo parado por um instante segura o botão esquerdo (o
 * arrasto termina quando o dedo sai), dois dedos rolam e um toque de dois dedos clica com o botão direito. Embaixo, os
 * botões esquerdo e direito e o "Arrastar", que segura o esquerdo até soltar. Para quem usa teclado ou leitor de tela, a
 * superfície explica o que faz e os botões fazem o mesmo que os toques. O ajuste de sensibilidade e da rolagem fica numa
 * folha aberta pelo botão do canto.
 */
@Component({
  selector: 'app-pc-touchpad-page',
  imports: [PcPadSettingsSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surface">
      <div
        class="pad"
        role="group"
        aria-labelledby="pad-help"
        [class.active]="active()"
        [class.holding]="holding()"
        tabindex="0"
        (pointerdown)="onDown($event)"
        (pointermove)="onMove($event)"
        (pointerup)="onUp($event)"
        (pointercancel)="onCancel()"
        (contextmenu)="$event.preventDefault()"
        (keydown)="onKey($event)"
      >
        <!-- A região fica sempre no DOM e só o texto muda: o leitor de tela anuncia a mudança, não o elemento novo. -->
        <span class="hint holding-label" role="status">{{ holding() ? draggingLabel : '' }}</span>
        @if (!holding()) {
          <span class="hint" aria-hidden="true" i18n="@@pc.pad.hint"
            >Deslize para mover · toque para clicar</span
          >
          <span class="hint second" aria-hidden="true" i18n="@@pc.pad.hint-scroll"
            >Dois dedos rolam</span
          >
        }
      </div>
      <button
        type="button"
        class="settings"
        aria-label="Ajustes do touchpad"
        i18n-aria-label="@@pc.pad.settings"
        (click)="settingsOpen.set(true)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M4 7h9M17 7h3M4 17h3M11 17h9'" />
          <circle cx="15" cy="7" r="2" />
          <circle cx="9" cy="17" r="2" />
        </svg>
      </button>
    </div>
    <p id="pad-help" class="sr-only" i18n="@@pc.pad.help">
      Touchpad: deslize um dedo para mover o ponteiro do PC, toque para clicar, mantenha o dedo
      parado para arrastar, deslize dois dedos para rolar e toque com dois dedos para o botão
      direito. Use os botões abaixo se preferir.
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
        [disabled]="!store.canSend() && !store.dragging()"
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

    @if (settingsOpen()) {
      <app-pc-pad-settings-sheet (closed)="settingsOpen.set(false)" />
    }
  `,
  styleUrl: './touchpad.page.css',
})
export class TouchpadPage {
  protected readonly store = inject(PcStore);
  protected readonly active = signal(false);
  protected readonly settingsOpen = signal(false);
  /** Uma pressão longa apertou o botão (vale na hora, antes de a resposta do PC chegar: o iOS não vibra). */
  private readonly pressing = signal(false);
  /** O botão está apertado (ou acabou de ser apertado pelo dedo): a superfície mostra isso com força. */
  protected readonly draggingLabel = $localize`:@@pc.pad.dragging:Arrastando`;
  protected readonly holding = computed(() => this.pressing() || this.store.dragging());
  /** O botão está apertado por uma pressão longa (e então é o fim do dedo que solta; o "Arrastar" é do botão). */
  private pressHold = false;

  private readonly gesture = new PadGesture({
    move: (dx, dy, elapsedMs) => this.store.movePointer(dx, dy, elapsedMs),
    scroll: (dx, dy, elapsedMs) => this.store.scrollPointer(dx, dy, elapsedMs),
    tap: (button) => this.press(button),
    dragStart: () => this.startHold(),
    dragEnd: () => this.endHold(),
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      // Cancelar solta o que uma pressão longa segurava; o resto (o "Arrastar") o store solta aqui.
      this.gesture.cancel();
      // Largar a tela com o botão apertado deixaria o PC arrastando para sempre.
      void this.store.release({ persistent: true });
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

  /**
   * Um dedo parado apertou o botão esquerdo. Se o "Arrastar" já o segurava, ou o aperto dele ainda está saindo, o dedo não
   * assume nada: o fim do dedo não pode soltar o que não apertou.
   */
  private startHold(): void {
    if (this.store.dragging() || this.store.buttonBusy) return;
    tick(20);
    this.pressHold = true;
    this.pressing.set(true);
    void this.store.startDrag().then((failure) => {
      // O aperto não passou: a superfície deixa de dizer que está arrastando. O `pressHold` fica: se o `UP` de segurança do
      // store também falhou, o botão pode estar apertado, e o fim do dedo ainda precisa soltar (sem botão é um não-fazer).
      if (failure) this.pressing.set(false);
    });
  }

  private endHold(): void {
    if (!this.pressHold) return;
    this.pressHold = false;
    this.pressing.set(false);
    void this.store.release({ persistent: true });
  }

  private finish(): void {
    this.active.set(false);
    this.store.endGesture();
  }
}
