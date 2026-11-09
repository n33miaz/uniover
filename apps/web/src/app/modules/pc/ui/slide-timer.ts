import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { tick } from '../input/haptics';

/** "mm:ss", ou "h:mm:ss" a partir de uma hora. */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (value: number) => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/**
 * Cronômetro da apresentação. Vive só neste aparelho, na tela: não lê nada do PC (nem as notas, nem os slides) e não manda
 * nada a ele. Conta pelo relógio (e não por tiques), então a tela apagada ou a aba em segundo plano não o atrasa.
 */
@Component({
  selector: 'app-pc-slide-timer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="time" role="timer" [attr.aria-label]="timeLabel">{{ text() }}</span>
    <button
      type="button"
      class="icon"
      [class.on]="running()"
      [attr.aria-label]="running() ? pauseLabel : startLabel"
      [attr.aria-pressed]="running()"
      (click)="toggle()"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        @if (running()) {
          <path [attr.d]="'M8 6v12M16 6v12'" />
        } @else {
          <path [attr.d]="'M8 5.5v13L18 12z'" />
        }
      </svg>
    </button>
    <button
      type="button"
      class="icon"
      [attr.aria-label]="resetLabel"
      [disabled]="elapsed() === 0 && !running()"
      (click)="reset()"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path [attr.d]="'M5 12a7 7 0 1 0 2.2-5.1M5 4v4h4'" />
      </svg>
    </button>
  `,
  styleUrl: './slide-timer.css',
})
export class PcSlideTimer {
  protected readonly timeLabel = $localize`:@@pc.slides.timer:Cronômetro`;
  protected readonly startLabel = $localize`:@@pc.slides.timer-start:Iniciar cronômetro`;
  protected readonly pauseLabel = $localize`:@@pc.slides.timer-pause:Pausar cronômetro`;
  protected readonly resetLabel = $localize`:@@pc.slides.timer-reset:Zerar cronômetro`;

  protected readonly running = signal(false);
  /** Segundos já contados (inteiros: o que a tela mostra). */
  protected readonly elapsed = signal(0);
  protected readonly text = computed(() => formatElapsed(this.elapsed()));

  /** O que passou antes da última retomada, em ms, e quando ela foi. */
  private before = 0;
  private resumedAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearInterval(this.timer));
  }

  protected toggle(): void {
    tick();
    if (this.running()) {
      this.before += Date.now() - this.resumedAt;
      clearInterval(this.timer);
      this.timer = undefined;
      this.running.set(false);
      this.elapsed.set(Math.floor(this.before / 1000));
      return;
    }
    this.resumedAt = Date.now();
    this.running.set(true);
    this.timer = setInterval(() => this.refresh(), 250);
  }

  protected reset(): void {
    tick();
    clearInterval(this.timer);
    this.timer = undefined;
    this.running.set(false);
    this.before = 0;
    this.elapsed.set(0);
  }

  private refresh(): void {
    this.elapsed.set(Math.floor((this.before + Date.now() - this.resumedAt) / 1000));
  }
}
