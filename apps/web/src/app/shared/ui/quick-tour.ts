import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { AccountScope } from '../../core/session/account-scope';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Um aviso breve, exibido uma vez por conta e versão neste aparelho. */
@Component({
  selector: 'app-quick-tour',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (available()) {
      <button
        #info
        type="button"
        class="secondary ui-btn info"
        [attr.aria-label]="heading()"
        [attr.aria-expanded]="opened()"
        (click)="toggle()"
      >
        <span aria-hidden="true" i18n="@@tour.icon">i</span>
      </button>
      @if (opened()) {
        <aside class="tour ui-card" [attr.aria-label]="heading()">
          <p role="status">{{ steps()[step()] }}</p>
          <div class="actions">
            <button type="button" class="secondary ui-btn" (click)="close()">
              <span i18n="@@tour.close">Fechar</span>
            </button>
            <button type="button" class="primary ui-btn" (click)="next()">
              @if (step() < steps().length - 1) {
                <span i18n="@@tour.next">Próximo</span>
              } @else {
                <span i18n="@@tour.done">Entendi</span>
              }
            </button>
          </div>
        </aside>
      }
    }
  `,
  styles: `
    :host {
      position: relative;
      display: block;
    }
    .info {
      min-width: var(--tap);
      min-height: var(--tap);
      font-weight: 750;
    }
    .tour {
      margin-block-start: var(--space-2);
      padding: var(--space-3);
    }
    .tour p {
      margin: 0 0 var(--space-2);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .actions button {
      min-height: var(--tap);
    }
  `,
})
export class QuickTour {
  readonly tourId = input.required<string>();
  readonly heading = input.required<string>();
  readonly steps = input.required<readonly string[]>();
  readonly days = input(30);

  private readonly account = inject(AccountScope);
  private readonly win = inject(DOCUMENT).defaultView;
  private readonly info = viewChild<ElementRef<HTMLButtonElement>>('info');
  private readonly key = computed(() => {
    const account = this.account.id();
    return account === null ? null : `uniover.quick-tour.${account}.${this.tourId()}`;
  });

  protected readonly opened = signal(false);
  protected readonly available = signal(false);
  protected readonly step = signal(0);
  private readonly seen = new Map<string, number>();

  constructor() {
    effect(() => {
      const key = this.key();
      const hasSteps = this.steps().length > 0;
      const days = this.days();
      untracked(() => {
        if (key === null || !hasSteps || days <= 0) {
          this.available.set(false);
          this.opened.set(false);
          return;
        }
        const now = Date.now();
        let seenAt = this.seen.get(key);
        try {
          const stored = Number(this.win?.localStorage.getItem(key));
          if (Number.isFinite(stored) && stored > 0) seenAt = stored;
          if (seenAt === undefined) this.win?.localStorage.setItem(key, String(now));
        } catch {
          // Sem armazenamento, a informação continua disponível enquanto a tela existe.
        }
        this.step.set(0);
        this.available.set(seenAt === undefined || now - seenAt < days * DAY_MS);
        this.opened.set(seenAt === undefined);
        this.seen.set(key, seenAt ?? now);
      });
    });
  }

  protected toggle(): void {
    if (this.opened()) this.close();
    else this.opened.set(true);
  }

  protected next(): void {
    if (this.step() === this.steps().length - 1) this.close();
    else this.step.update((step) => step + 1);
  }

  protected close(): void {
    this.opened.set(false);
    this.step.set(0);
    this.info()?.nativeElement.focus();
  }
}
