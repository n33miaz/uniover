import { DestroyRef, Component, inject, signal } from '@angular/core';
import { TV_CONFIG } from '../data/tv-config';
import { TvPrefs } from '../data/tv-prefs';
import { TvStore } from '../data/tv-store';
import { HoldRepeater } from './hold-repeater';
import {
  DEFAULT_GESTURE,
  GestureConfig,
  PadDirection,
  STEP_PX_BY_SPEED,
  TouchGesture,
} from './touch-gesture';
import { vibrate } from './key-button';

/**
 * Superfície do touchpad: deslizar manda as setas (e segurar o dedo deslocado repete), um toque curto e parado
 * manda OK. O modo "Botões" continua sendo a alternativa acessível; para leitor de tela e teclado a superfície
 * explica isso e o OK também responde ao Enter e ao Espaço.
 */
@Component({
  selector: 'app-touchpad-surface',
  template: `
    <div
      class="pad"
      role="group"
      aria-labelledby="pad-help"
      [class.active]="active()"
      [class.disabled]="!store.canSend()"
      tabindex="0"
      (pointerdown)="onDown($event)"
      (pointermove)="onMove($event)"
      (pointerup)="onUp($event)"
      (pointercancel)="onCancel()"
      (lostpointercapture)="onCancel()"
      (contextmenu)="$event.preventDefault()"
      (keydown)="onKey($event)"
    >
      <span class="hint" aria-hidden="true" i18n="@@tv.pad.hint"
        >Deslize para mover · toque para OK</span
      >
    </div>
    <p id="pad-help" class="sr-only" i18n="@@tv.pad.help">
      Touchpad: deslize para mover o cursor da TV e toque rápido para OK. Se preferir, volte ao modo
      Botões.
    </p>
  `,
  styleUrl: './touchpad-surface.css',
})
export class TouchpadSurface {
  protected readonly store = inject(TvStore);
  private readonly config = inject(TV_CONFIG);
  private readonly prefs = inject(TvPrefs);

  protected readonly active = signal(false);

  private readonly gesture = new TouchGesture(this.liveGesture());
  private readonly repeater = new HoldRepeater(
    () => this.repeatHeld(),
    this.config.repeatIntervalMs,
    this.config.repeatIntervalMs,
    () => this.store.inFlightKeys() >= this.config.maxKeysInFlight,
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.repeater.stop());
  }

  protected onDown(event: PointerEvent): void {
    if (!event.isPrimary || !this.store.canSend()) return;
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    this.active.set(true);
    this.gesture.start(event.clientX, event.clientY, event.timeStamp);
  }

  protected onMove(event: PointerEvent): void {
    if (!this.active()) return;
    const direction = this.gesture.move(event.clientX, event.clientY);
    if (direction) {
      this.fire(direction);
      this.repeater.start();
    } else if (this.gesture.held === null) {
      this.repeater.stop();
    }
  }

  protected onUp(event: PointerEvent): void {
    if (!this.active()) return;
    this.finish();
    if (this.gesture.end(event.timeStamp)) this.fire('OK');
  }

  protected onCancel(): void {
    this.finish();
    this.gesture.cancel();
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.fire('OK');
      return;
    }
    const arrows: Record<string, PadDirection> = {
      ArrowUp: 'UP',
      ArrowDown: 'DOWN',
      ArrowLeft: 'LEFT',
      ArrowRight: 'RIGHT',
    };
    const direction = arrows[event.key];
    if (direction) {
      event.preventDefault();
      this.fire(direction);
    }
  }

  /** O deslocamento da seta segue a sensibilidade de Personalizar na hora, sem recriar o gesto. */
  private liveGesture(): GestureConfig {
    const prefs = this.prefs;
    return {
      ...DEFAULT_GESTURE,
      get stepPx() {
        return STEP_PX_BY_SPEED[prefs.padSpeed()];
      },
    };
  }

  private finish(): void {
    this.repeater.stop();
    this.active.set(false);
  }

  private repeatHeld(): void {
    const held = this.gesture.held;
    if (held) this.fire(held);
  }

  private fire(key: PadDirection | 'OK'): void {
    vibrate(this.prefs.vibration());
    void this.store.sendKey(key).then((ok) => {
      if (!ok) this.repeater.stop();
    });
  }
}
