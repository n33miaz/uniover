import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { OfflineQueue } from '../../../core/offline-queue/offline-queue';
import { TrainingSync } from '../data/sync/training-sync';

export type TrainingSyncState = 'ok' | 'busy' | 'pending' | 'offline' | 'failed';

/** Quanto tempo o anel verde fica à vista depois que tudo chegou ao servidor. */
export const SYNC_OK_LINGER_MS = 3000;

/**
 * O estado do anel de sincronização do topo do Treino: uma só palavra (em dia, sincronizando, pendente, sem rede, erro) e
 * se o anel está à vista. Em dia ele some depois de alguns segundos (só aparece verde logo após sair de outro estado);
 * a folha aberta o mantém à vista. A sincronização em si continua automática: nada aqui a dispara.
 */
@Injectable()
export class TrainingSyncIndicator {
  private readonly queue = inject(OfflineQueue);
  private readonly sync = inject(TrainingSync);
  private readonly connectivity = inject(ConnectivityService);

  readonly failed = this.queue.failedCount;
  readonly pending = this.queue.pendingCount;
  readonly online = this.connectivity.online;

  readonly state = computed<TrainingSyncState>(() => {
    if (this.failed() > 0) return 'failed';
    if (this.queue.syncing() || this.sync.pulling() || this.retrying()) return 'busy';
    if (!this.online()) return 'offline';
    if (this.sync.error() !== null) return 'failed';
    if (this.pending() > 0) return 'pending';
    return 'ok';
  });

  /** O número do anel: o que espera envio, ou o que o servidor recusou. */
  readonly count = computed(() => (this.failed() > 0 ? this.failed() : this.pending()));

  /** O instante mais novo entre o último envio aceito e o último puxar completo. */
  readonly lastSyncAt = computed(() => {
    const latest = Math.max(this.queue.lastSyncAt() ?? 0, this.sync.lastPullAt() ?? 0);
    return latest > 0 ? latest : null;
  });

  /** "Tentar de Novo" está em andamento (reenfileirar o recusado, enviar e puxar). */
  readonly retrying = signal(false);

  /** A folha curta do anel está aberta. */
  readonly sheetOpen = signal(false);
  private readonly lingering = signal(false);

  readonly visible = computed(() => this.state() !== 'ok' || this.lingering() || this.sheetOpen());

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    let previous: TrainingSyncState = this.state();
    effect(() => {
      const state = this.state();
      untracked(() => {
        if (state !== 'ok') {
          this.clearTimer();
          this.lingering.set(false);
        } else if (previous !== 'ok') {
          this.lingering.set(true);
          this.clearTimer();
          this.timer = setTimeout(() => this.lingering.set(false), SYNC_OK_LINGER_MS);
        }
        previous = state;
      });
    });
    inject(DestroyRef).onDestroy(() => this.clearTimer());
  }

  /**
   * Tenta de novo o que o servidor recusou: devolve cada item recusado à fila, esvazia-a e puxa o que o servidor tem. Só a
   * folha de erro oferece isto, e abrir a folha nunca o dispara.
   */
  async retry(): Promise<void> {
    if (this.retrying()) return;
    this.retrying.set(true);
    try {
      const refused = (await this.queue.items()).filter((item) => item.status === 'failed');
      await Promise.all(refused.map((item) => this.queue.retry(item.id)));
      await Promise.all([this.queue.syncNow(), this.sync.pullNow()]);
    } catch {
      // As fontes de sincronização guardam o próprio estado de erro, que o anel e a folha já mostram.
    } finally {
      this.retrying.set(false);
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
