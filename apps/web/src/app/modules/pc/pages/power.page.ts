import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { PcConfirmSheet } from '../ui/confirm-sheet';
import { PcStore } from '../data/pc-store';
import { tick } from '../input/haptics';

type Pending = 'SLEEP' | 'SHUTDOWN';

/** Quanto tempo o botão de cancelar o desligamento fica à vista (a contagem do PC é menor que isto). */
const CANCEL_WINDOW_MS = 5 * 60_000;

/**
 * Energia do PC: bloquear vale na hora; suspender e desligar pedem confirmação numa folha (e a API só aceita com a
 * confirmação). Desligar usa a contagem do próprio Windows, com aviso na tela do PC, e o botão de cancelar fica à vista
 * logo depois, porque suspender e desligar derrubam a conexão e não há como desfazer de outro jeito.
 */
@Component({
  selector: 'app-pc-power-page',
  imports: [PcConfirmSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="actions">
      <button type="button" class="action" [disabled]="!store.canSend() || busy()" (click)="lock()">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path [attr.d]="'M8 11V8a4 4 0 0 1 8 0v3'" />
        </svg>
        <span i18n="@@pc.power.lock">Bloquear</span>
      </button>
      <button
        type="button"
        class="action"
        [disabled]="!store.canSend() || busy()"
        (click)="ask('SLEEP')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'" />
        </svg>
        <span i18n="@@pc.power.sleep">Suspender</span>
      </button>
      <button
        type="button"
        class="action danger"
        [disabled]="!store.canSend() || busy()"
        (click)="ask('SHUTDOWN')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M12 3v8M6.4 6.6a8 8 0 1 0 11.2 0'" />
        </svg>
        <span i18n="@@pc.power.shutdown">Desligar</span>
      </button>
    </div>

    @if (cancelVisible()) {
      <div class="cancel" role="status">
        <p i18n="@@pc.power.counting">O PC vai desligar. O aviso aparece na tela dele.</p>
        <button
          type="button"
          class="ui-btn"
          [disabled]="!store.canSend() || busy()"
          (click)="cancelShutdown()"
          i18n="@@pc.power.cancel"
        >
          Cancelar Desligamento
        </button>
      </div>
    }
    @if (message(); as text) {
      <p class="error" role="alert">{{ text }}</p>
    }

    @if (pending(); as action) {
      <app-pc-confirm-sheet
        [heading]="action === 'SHUTDOWN' ? shutdownTitle : sleepTitle"
        [text]="action === 'SHUTDOWN' ? shutdownText : sleepText"
        [confirmLabel]="action === 'SHUTDOWN' ? shutdownLabel : sleepLabel"
        [busy]="busy()"
        [error]="sheetError()"
        (confirmed)="confirm(action)"
        (closed)="pending.set(null)"
      />
    }
  `,
  styleUrl: './power.page.css',
})
export class PowerPage {
  protected readonly store = inject(PcStore);
  protected readonly pending = signal<Pending | null>(null);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly sheetError = signal<string | null>(null);
  /** O desligamento foi pedido há pouco: mostra o botão que cancela a contagem. */
  protected readonly cancelVisible = signal(false);

  protected readonly sleepTitle = $localize`:@@pc.power.sleep-title:Suspender o PC?`;
  protected readonly sleepText = $localize`:@@pc.power.sleep-text:A conexão cai e o PC só volta mexendo nele.`;
  protected readonly sleepLabel = $localize`:@@pc.power.sleep-confirm:Suspender`;
  protected readonly shutdownTitle = $localize`:@@pc.power.shutdown-title:Desligar o PC?`;
  protected readonly shutdownText = $localize`:@@pc.power.shutdown-text:O Windows avisa na tela e conta alguns segundos. Dá para cancelar aqui antes do fim.`;
  protected readonly shutdownLabel = $localize`:@@pc.power.shutdown-confirm:Desligar`;

  private readonly sheet = viewChild(PcConfirmSheet);
  private hideTimer: number | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    });
  }

  protected async lock(): Promise<void> {
    tick();
    await this.run('LOCK');
  }

  protected ask(action: Pending): void {
    tick();
    this.message.set(null);
    this.sheetError.set(null);
    this.pending.set(action);
  }

  protected async confirm(action: Pending): Promise<void> {
    if (this.busy()) return;
    const ok = await this.run(action, true);
    if (!ok) return;
    this.sheet()?.close();
    if (action === 'SHUTDOWN') this.showCancel();
  }

  protected async cancelShutdown(): Promise<void> {
    tick();
    if (await this.run('CANCEL_SHUTDOWN')) this.cancelVisible.set(false);
  }

  private async run(
    action: 'LOCK' | Pending | 'CANCEL_SHUTDOWN',
    confirmed = false,
  ): Promise<boolean> {
    this.busy.set(true);
    this.message.set(null);
    this.sheetError.set(null);
    const failure = await this.store.power(action, confirmed);
    this.busy.set(false);
    if (failure) {
      // A falha aparece onde a pessoa está olhando: dentro da folha, se ela estiver aberta.
      if (this.pending()) this.sheetError.set(failure.message);
      else this.message.set(failure.message);
      return false;
    }
    return true;
  }

  private showCancel(): void {
    this.cancelVisible.set(true);
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.cancelVisible.set(false), CANCEL_WINDOW_MS);
  }
}
