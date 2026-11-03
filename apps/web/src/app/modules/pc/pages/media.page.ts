import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { PcStore } from '../data/pc-store';
import { tick } from '../input/haptics';
import type { PcMediaAction } from '../data/pc-types';

/** Segurar o volume repete: espera um pouco antes da primeira repetição e depois segue neste ritmo. */
const REPEAT_AFTER_MS = 420;
const REPEAT_EVERY_MS = 190;

/**
 * Mídia do PC: tocar e pausar, faixa anterior e seguinte, volume (segurar repete) e mudo. Embaixo, os favoritos que o
 * próprio PC deixa abrir (a lista vem do PC; o caminho do programa nunca chega aqui).
 */
@Component({
  selector: 'app-pc-media-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="transport" role="group" aria-labelledby="transport-title">
      <h2 id="transport-title" class="sr-only" i18n="@@pc.media.transport">Reprodução</h2>
      <button
        type="button"
        class="round"
        aria-label="Faixa anterior"
        i18n-aria-label="@@pc.media.previous"
        [disabled]="!store.canSend()"
        (click)="press('PREVIOUS')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M7 6v12M18 6.5v11L9.5 12z'" />
        </svg>
      </button>
      <button
        type="button"
        class="round big"
        aria-label="Tocar ou pausar"
        i18n-aria-label="@@pc.media.play-pause"
        [disabled]="!store.canSend()"
        (click)="press('PLAY_PAUSE')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M7 5.5v13L17.5 12z'" class="solid" />
        </svg>
      </button>
      <button
        type="button"
        class="round"
        aria-label="Próxima faixa"
        i18n-aria-label="@@pc.media.next"
        [disabled]="!store.canSend()"
        (click)="press('NEXT')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M17 6v12M6 6.5v11L14.5 12z'" />
        </svg>
      </button>
    </div>

    <div class="volume" role="group" aria-labelledby="volume-title">
      <h2 id="volume-title" class="sr-only" i18n="@@pc.media.volume">Volume</h2>
      <button
        type="button"
        class="vol"
        aria-label="Diminuir o volume"
        i18n-aria-label="@@pc.media.volume-down"
        [disabled]="!store.canSend()"
        (pointerdown)="hold('VOLUME_DOWN', $event)"
        (pointerup)="release()"
        (pointercancel)="release()"
        (pointerleave)="release()"
        (click)="$event.detail === 0 && press('VOLUME_DOWN')"
        (contextmenu)="$event.preventDefault()"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M4 10v4h3.5L12 18V6L7.5 10zM16 9.5a4 4 0 0 1 0 5'" />
        </svg>
      </button>
      <button
        type="button"
        class="vol mute"
        aria-label="Mudo"
        i18n-aria-label="@@pc.media.mute"
        [disabled]="!store.canSend()"
        (click)="press('MUTE')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M4 10v4h3.5L12 18V6L7.5 10zM16 9.5l5 5M21 9.5l-5 5'" />
        </svg>
      </button>
      <button
        type="button"
        class="vol"
        aria-label="Aumentar o volume"
        i18n-aria-label="@@pc.media.volume-up"
        [disabled]="!store.canSend()"
        (pointerdown)="hold('VOLUME_UP', $event)"
        (pointerup)="release()"
        (pointercancel)="release()"
        (pointerleave)="release()"
        (click)="$event.detail === 0 && press('VOLUME_UP')"
        (contextmenu)="$event.preventDefault()"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            [attr.d]="'M4 10v4h3.5L12 18V6L7.5 10zM15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11'"
          />
        </svg>
      </button>
    </div>

    @if (store.apps().length > 0) {
      <h2 class="section" i18n="@@pc.apps.title">Abrir no PC</h2>
      <ul class="apps">
        @for (app of store.apps(); track app.id) {
          <li>
            <button
              type="button"
              class="app ui-btn"
              [disabled]="!store.canSend() || launching() === app.id"
              (click)="launch(app.id)"
            >
              {{ app.label }}
            </button>
          </li>
        }
      </ul>
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
    }
  `,
  styleUrl: './media.page.css',
})
export class MediaPage {
  protected readonly store = inject(PcStore);
  protected readonly launching = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  private startTimer: number | null = null;
  private repeatTimer: number | null = null;
  private busy = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.release());
  }

  protected press(action: PcMediaAction): void {
    tick();
    void this.store.sendMedia(action);
  }

  /** Aperta uma vez já e, se o dedo ficar, repete o volume até soltar (um pedido por vez). */
  protected hold(action: 'VOLUME_UP' | 'VOLUME_DOWN', event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    this.release();
    this.step(action);
    this.startTimer = window.setTimeout(() => {
      this.repeatTimer = window.setInterval(() => this.step(action), REPEAT_EVERY_MS);
    }, REPEAT_AFTER_MS);
  }

  protected release(): void {
    if (this.startTimer !== null) window.clearTimeout(this.startTimer);
    if (this.repeatTimer !== null) window.clearInterval(this.repeatTimer);
    this.startTimer = null;
    this.repeatTimer = null;
  }

  protected async launch(id: string): Promise<void> {
    if (this.launching()) return;
    this.launching.set(id);
    this.error.set(null);
    tick();
    const failure = await this.store.launch(id);
    this.launching.set(null);
    if (failure) this.error.set(failure.message);
  }

  private step(action: PcMediaAction): void {
    if (this.busy) return;
    this.busy = true;
    tick(5);
    void this.store.sendMedia(action).finally(() => {
      this.busy = false;
    });
  }
}
