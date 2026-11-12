import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { SessionState } from '../../core/session/session-state';
import { ShoppingEconomizeApi, type EconomizeAdvice } from './shopping-economize-api';
import { formatMoney } from './shopping-format';

/** As esperas entre as consultas enquanto o Economize acorda; depois da última, a tela desiste por esta visita. */
export const ADVICE_RETRY_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000];

const WEEKDAY = new Intl.DateTimeFormat('pt-BR', { weekday: 'long' });

/** "quinta, 14/11": o dia da semana sem "-feira" e a data curta. */
export function formatBestDay(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const weekday = WEEKDAY.format(date).replace('-feira', '');
  return `${weekday}, ${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}`;
}

/**
 * O cartão do Economize no Mercado Agora: quanto está livre até o salário e o melhor dia para comprar. Só para o
 * administrador (os demais nem consultam; a API recusaria). Enquanto o Economize acorda, consulta de novo em 5, 10, 20 e
 * 40 s, só com a tela à vista. Desligado, ou recusado, não mostra nada; indisponível, uma linha discreta.
 */
@Component({
  selector: 'app-shopping-advice-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (view()) {
      @case ('waking') {
        <p class="quiet" role="status" i18n="@@shopping.advice.waking">Buscando no Economize…</p>
      }
      @case ('down') {
        <p class="quiet" i18n="@@shopping.advice.down">Economize indisponível agora</p>
      }
      @case ('ready') {
        <div class="card">
          @if (free(); as amount) {
            <p class="free">
              <span i18n="@@shopping.advice.free">Livre até o salário</span>
              <strong class="money">{{ amount }}</strong>
            </p>
          }
          @if (bestDay(); as day) {
            <p class="day" i18n="@@shopping.advice.best-day">Melhor dia para comprar: {{ day }}</p>
          }
          @if (canUseAsBudget()) {
            <button type="button" class="ui-btn use" (click)="use()" i18n="@@shopping.advice.use">
              Usar como Teto
            </button>
          }
        </div>
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }
    :host:empty {
      display: none;
    }
    p {
      margin: 0;
    }
    .quiet {
      color: var(--a-ink2);
      font-size: var(--fs-small);
      text-align: center;
    }
    .card {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2) var(--space-3);
      padding: var(--space-3) var(--space-4);
      border-radius: var(--radius-lg);
      background: var(--a-accent-soft);
      color: var(--a-accent-ink);
    }
    .free {
      display: flex;
      flex-direction: column;
      font-size: var(--fs-small);
    }
    .free strong {
      font-size: var(--fs-title);
    }
    .money {
      font-variant-numeric: tabular-nums;
    }
    .day {
      flex: 1 1 100%;
      font-size: var(--fs-small);
    }
    .use {
      min-height: 36px;
    }
  `,
})
export class ShoppingAdviceCard {
  private readonly api = inject(ShoppingEconomizeApi);
  private readonly session = inject(SessionState);

  /** A compra ainda não tem teto: o livre até o salário pode virar o teto com um toque. */
  readonly budgetEmpty = input(false);
  /** O valor (em reais) escolhido como teto. */
  readonly useAsBudget = output<number>();

  private readonly advice = signal<EconomizeAdvice | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private waitingVisible = false;
  private stopped = false;

  protected readonly view = computed(() => {
    const advice = this.advice();
    if (!advice) return null;
    if (advice.available) return 'ready';
    switch (advice.reason) {
      case 'waking':
        return 'waking';
      case 'unauthorized':
      case 'unavailable':
        return 'down';
      default:
        return null;
    }
  });
  private readonly freeCents = computed(() => this.advice()?.free?.freeCents ?? null);
  protected readonly free = computed(() => {
    const cents = this.freeCents();
    return cents === null ? null : formatMoney(cents / 100);
  });
  protected readonly bestDay = computed(() => {
    const day = this.advice()?.bestDay;
    return day ? formatBestDay(day) : null;
  });
  protected readonly canUseAsBudget = computed(
    () => this.budgetEmpty() && (this.freeCents() ?? 0) > 0,
  );

  constructor() {
    const visible = (): void => {
      if (document.visibilityState === 'visible' && this.waitingVisible) {
        this.waitingVisible = false;
        void this.load();
      }
    };
    document.addEventListener('visibilitychange', visible);
    inject(DestroyRef).onDestroy(() => {
      this.stopped = true;
      if (this.timer !== null) clearTimeout(this.timer);
      document.removeEventListener('visibilitychange', visible);
    });
    if (this.session.role() === 'owner') void this.load();
  }

  protected use(): void {
    const cents = this.freeCents();
    if (cents !== null && cents > 0) this.useAsBudget.emit(cents / 100);
  }

  private async load(): Promise<void> {
    if (this.stopped) return;
    try {
      const advice = await this.api.advice();
      if (this.stopped) return;
      this.advice.set(advice);
      if (!advice.available && advice.reason === 'waking') this.retry();
    } catch {
      // 403 (não é administrador), sem rede, servidor dormindo: o cartão simplesmente não aparece.
      this.advice.set(null);
    }
  }

  private retry(): void {
    if (this.attempt >= ADVICE_RETRY_MS.length) {
      // Passadas as quatro esperas, desiste por esta visita: fica a linha discreta.
      this.advice.update((advice) => (advice ? { ...advice, reason: 'unavailable' } : advice));
      return;
    }
    const delay = ADVICE_RETRY_MS[this.attempt];
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (document.visibilityState === 'visible') void this.load();
      else this.waitingVisible = true;
    }, delay);
  }
}
