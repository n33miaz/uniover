import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TvLivreStore } from '../data/livre-store';
import { SLEEP_MAX_MINUTES } from '../data/livre-types';
import { SLEEP_TIME_ANIMATION } from './sleep-time-animation';

/** Os tempos prontos do Modo Dormir, em minutos: 0 é "só acorda com o botão" (sem limite). */
const PRESETS: readonly number[] = [0, 30, 60, 120, 480];
/** Quanto tempo o toque "pulsa" (o anel que sai do botão); a animação em si é do CSS. */
const PULSE_MS = 600;

/** O texto curto de um tempo: "30 min", "1 h", "1 h 30 min". */
export function sleepTimeLabel(minutes: number): string {
  if (minutes < 60) return $localize`:@@tv-livre.sleep.minutes:${minutes}:minutes: min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? $localize`:@@tv-livre.sleep.hours:${hours}:hours: h`
    : $localize`:@@tv-livre.sleep.hours-minutes:${hours}:hours: h ${rest}:minutes: min`;
}

/**
 * O tempo do Modo Dormir em botões que valem na hora: cinco tempos prontos e um lápis para digitar outro. O tempo escolhido
 * fica marcado; tocar de novo nele volta a "Só Botão" (sem limite), como o campo numérico que ele substitui. A confirmação
 * tem três momentos (toque, envio, a TV recebeu) e a animação deles é do CSS, escolhida em `sleep-time-animation.ts`.
 * Respeita "Reduzir movimento": sem ele o CSS não anima, e a mudança continua clara pelas cores e pelo texto de estado.
 */
@Component({
  selector: 'app-livre-sleep-time',
  templateUrl: './livre-sleep-time.html',
  styleUrl: './livre-sleep-time.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-animation]': 'animation' },
})
export class LivreSleepTime {
  protected readonly store = inject(TvLivreStore);
  private readonly destroy = inject(DestroyRef);
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  protected readonly animation = SLEEP_TIME_ANIMATION;
  protected readonly max = SLEEP_MAX_MINUTES;
  protected readonly editing = signal(false);
  /** O tempo que acabou de ser tocado (some depois do pulso). */
  protected readonly pulsing = signal<number | null>(null);
  /** O tempo que a TV confirmou agora há pouco (para o selo); some quando o tempo muda por outro caminho. */
  protected readonly confirmed = signal<number | null>(null);
  /** O tempo que está indo para a TV. */
  private readonly target = signal<number | null>(null);
  private pulseTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly idle = computed(() => this.store.canUse() && this.store.busy() === null);
  protected readonly selected = computed(() => this.store.draft()?.sleep.maxMinutes ?? 0);
  protected readonly sending = computed(() => this.store.busy() === 'sleep-time');

  /** Os botões: os prontos e, se o tempo que vale é outro (digitado), mais um botão para ele, antes do lápis. */
  protected readonly chips = computed(() => {
    const current = this.selected();
    const values = PRESETS.includes(current) ? PRESETS : [...PRESETS, current];
    return values.map((minutes) => ({
      minutes,
      label:
        minutes === 0 ? $localize`:@@tv-livre.sleep.button-only:Só Botão` : sleepTimeLabel(minutes),
    }));
  });

  /** A frase de estado, que também é o que o leitor de tela anuncia. */
  protected readonly status = computed(() => {
    const minutes = this.selected();
    const time = sleepTimeLabel(minutes);
    if (this.sending()) return $localize`:@@tv-livre.sleep.status-sending:Enviando para a TV…`;
    if (!this.store.quickSleep()) {
      if (this.store.dirty()) {
        return $localize`:@@tv-livre.sleep.status-pending:Toque em Aplicar na TV para valer.`;
      }
      return minutes === 0
        ? $localize`:@@tv-livre.sleep.status-none:Acorda só com um botão do controle.`
        : $localize`:@@tv-livre.sleep.status-after:Acorda sozinha em ${time}:time:.`;
    }
    return minutes === 0
      ? $localize`:@@tv-livre.sleep.status-none-now:Vale: acorda só com um botão do controle.`
      : $localize`:@@tv-livre.sleep.status-after-now:Vale: acorda sozinha em ${time}:time:.`;
  });

  constructor() {
    this.destroy.onDestroy(() => {
      if (this.pulseTimer) clearTimeout(this.pulseTimer);
    });
    // O selo é de um envio que deu certo; se o tempo muda por outro caminho, ele sai.
    effect(() => {
      const current = this.selected();
      untracked(() => {
        const shown = this.confirmed();
        if (shown !== null && shown !== current) this.confirmed.set(null);
      });
    });
    effect(() => {
      if (this.editing()) queueMicrotask(() => this.field()?.nativeElement.focus());
    });
  }

  protected isChosen(minutes: number): boolean {
    return minutes === this.selected();
  }

  /** O botão está recebendo o envio agora (a barra enche nele). */
  protected isSending(minutes: number): boolean {
    return this.sending() && this.target() === minutes;
  }

  /** Tocar no tempo que vale (e não é "Só Botão") volta a "Só Botão"; do contrário, escolhe o tocado. */
  protected async choose(minutes: number): Promise<void> {
    if (!this.idle()) return;
    this.editing.set(false);
    const next = minutes !== 0 && minutes === this.selected() ? 0 : minutes;
    if (next === this.selected()) return;
    await this.send(next, minutes);
  }

  protected openEditor(): void {
    if (this.idle()) this.editing.update((open) => !open);
  }

  protected async applyTyped(event: Event): Promise<void> {
    event.preventDefault();
    const raw = this.field()?.nativeElement.value ?? '';
    const typed = raw.trim() === '' ? 0 : Number(raw);
    if (!Number.isFinite(typed)) return;
    this.editing.set(false);
    const minutes = Math.min(SLEEP_MAX_MINUTES, Math.max(0, Math.round(typed)));
    if (minutes !== this.selected()) await this.send(minutes, minutes);
  }

  protected closeEditor(): void {
    this.editing.set(false);
  }

  private async send(minutes: number, touched: number): Promise<void> {
    this.pulse(touched);
    this.target.set(minutes);
    this.confirmed.set(null);
    const ok = await this.store.setSleepTime(minutes);
    // Só vale como "a TV recebeu" quando o tempo foi mesmo guardado pelo caminho rápido.
    if (ok && this.store.quickSleep()) this.confirmed.set(minutes);
    this.target.set(null);
  }

  private pulse(minutes: number): void {
    this.pulsing.set(minutes);
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    this.pulseTimer = setTimeout(() => this.pulsing.set(null), PULSE_MS);
  }
}
