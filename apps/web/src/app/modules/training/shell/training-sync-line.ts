import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { OfflineQueue } from '../../../core/offline-queue/offline-queue';
import { SyncStatusLine } from '../../../core/offline-queue/sync-status-line';
import { TrainingSync } from '../data/sync/training-sync';
import { TrainingGlyph, TrainingGlyphName } from './training-glyph';

/**
 * A linha de sincronização do topo das telas do Treino: uma linha fina que diz se o aparelho está em dia, quanto
 * falta subir e, sem rede ou com o servidor fora, que o app segue com o que está guardado ("sem rede" é estado
 * normal, não erro). Só ganha botão quando há o que fazer: "Sincronizar agora" (há envio pendente) ou "Ver" (o
 * servidor recusou algo e a pessoa precisa decidir).
 */
@Component({
  selector: 'app-training-sync-line',
  imports: [SyncStatusLine, TrainingGlyph],
  template: `
    <div
      class="line"
      [class.empty]="!visible()"
      [class.warn]="!reachable()"
      [class.bad]="failed() > 0"
    >
      <app-training-glyph [name]="glyph()" />
      <div class="text">
        @if (note(); as value) {
          <span class="note">{{ value }}</span>
        }
        @if (updating()) {
          <span class="note" i18n="@@training.sync.updating">Atualizando…</span>
        }
        <app-sync-status-line
          [pending]="pending()"
          [failed]="failed()"
          [lastSyncAt]="lastSyncAt()"
        />
      </div>
      @if (failed() > 0) {
        <button type="button" class="act" (click)="issues.emit()" i18n="@@training.sync.see">
          Ver
        </button>
      } @else if (pending() > 0 && reachable()) {
        <button type="button" class="act" [disabled]="busy()" (click)="syncNow()">
          @if (busy()) {
            <span class="ui-spinner" aria-hidden="true"></span>
          }
          <span i18n="@@training.sync.now">Sincronizar agora</span>
        </button>
      }
    </div>
  `,
  styleUrl: './training-sync-line.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingSyncLine {
  private readonly queue = inject(OfflineQueue);
  private readonly sync = inject(TrainingSync);
  private readonly connectivity = inject(ConnectivityService);

  /** A pessoa pediu para ver o que o servidor recusou. */
  readonly issues = output<void>();

  protected readonly pending = this.queue.pendingCount;
  protected readonly failed = this.queue.failedCount;
  protected readonly online = this.connectivity.online;

  /** Há rede e o último puxar não falhou: o que se vê é o que o servidor tem. */
  protected readonly reachable = computed(() => this.online() && this.sync.error() === null);
  protected readonly busy = computed(() => this.queue.syncing() || this.sync.pulling());

  /** O instante mais novo entre o último envio aceito e o último puxar completo. */
  protected readonly lastSyncAt = computed(() => {
    const latest = Math.max(this.queue.lastSyncAt() ?? 0, this.sync.lastPullAt() ?? 0);
    return latest > 0 ? latest : null;
  });

  protected readonly note = computed(() => {
    if (!this.online()) {
      return $localize`:@@training.sync.offline:Sem rede: usando o que está no aparelho`;
    }
    if (this.sync.error() !== null) {
      return $localize`:@@training.sync.unreachable:Sem resposta do servidor: usando o que está no aparelho`;
    }
    return '';
  });

  /** Primeira passada em andamento: ainda não há hora de sincronização para mostrar. */
  protected readonly updating = computed(() => this.sync.pulling() && this.lastSyncAt() === null);

  /** A linha só aparece quando tem o que dizer; sem nada a dizer ela não gasta altura da tela. */
  protected readonly visible = computed(
    () =>
      this.failed() > 0 ||
      this.pending() > 0 ||
      this.note() !== '' ||
      this.lastSyncAt() !== null ||
      this.updating(),
  );

  protected readonly glyph = computed<TrainingGlyphName>(() => {
    if (this.failed() > 0) return 'alert';
    if (!this.reachable()) return 'offline';
    if (this.pending() > 0 || this.updating()) return 'hourglass';
    return 'check';
  });

  protected syncNow(): void {
    void this.sync.pullNow();
  }
}
