import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { PcSlideTimerState } from '../data/pc-slide-timer';
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

let nextTimer = 0;

/**
 * Cronômetro da apresentação. A conta é do serviço (`PcSlideTimerState`): trocar de modo ou de aba não a perde. Aqui só há o
 * desenho e o relógio que o atualiza enquanto a tela existe e a conta corre. O nome ("Cronômetro") é um rótulo escondido, e
 * o tempo é o conteúdo do `timer`: o leitor de tela lê os dois (um `aria-label` no lugar do tempo o esconderia), e a região
 * não anuncia a cada segundo.
 */
@Component({
  selector: 'app-pc-slide-timer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="sr-only" [id]="labelId" i18n="@@pc.slides.timer">Cronômetro</span>
    <span class="time" role="timer" [attr.aria-labelledby]="labelId">{{ text() }}</span>
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
  protected readonly labelId = `pc-timer-${nextTimer++}`;
  protected readonly startLabel = $localize`:@@pc.slides.timer-start:Iniciar cronômetro`;
  protected readonly pauseLabel = $localize`:@@pc.slides.timer-pause:Pausar cronômetro`;
  protected readonly resetLabel = $localize`:@@pc.slides.timer-reset:Zerar cronômetro`;

  private readonly state = inject(PcSlideTimerState);
  protected readonly running = this.state.running;
  /** O relógio da tela: só anda enquanto a conta corre (parada, o tempo mostrado é o do serviço). */
  private readonly now = signal(Date.now());
  /** Segundos já contados (inteiros: o que a tela mostra). */
  protected readonly elapsed = computed(() => Math.floor(this.state.elapsedMs(this.now()) / 1000));
  protected readonly text = computed(() => formatElapsed(this.elapsed()));

  constructor() {
    effect((onCleanup) => {
      if (!this.state.running()) {
        this.now.set(Date.now());
        return;
      }
      const timer = setInterval(() => this.now.set(Date.now()), 250);
      onCleanup(() => clearInterval(timer));
    });
  }

  protected toggle(): void {
    tick();
    this.state.toggle();
    this.now.set(Date.now());
  }

  protected reset(): void {
    tick();
    this.state.reset();
    this.now.set(Date.now());
  }
}
