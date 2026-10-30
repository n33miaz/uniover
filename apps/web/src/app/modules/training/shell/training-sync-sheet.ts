import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { SyncStatusLine } from '../../../core/offline-queue/sync-status-line';
import { TrainingSheet } from './training-sheet';
import { TrainingSyncIndicator } from './training-sync-indicator';

/**
 * A folha curta do anel: diz o estado, a hora do último envio e, só no erro, oferece "Tentar de Novo" e "Ver os
 * Recusados" (a folha dos itens que o servidor recusou). Sincronizar continua automático: não há botão para isso.
 */
@Component({
  selector: 'app-training-sync-sheet',
  imports: [SyncStatusLine, TrainingSheet],
  template: `
    <app-training-sheet [heading]="heading" (closed)="closed.emit()">
      <p class="state" role="status">{{ text() }}</p>
      <app-sync-status-line
        [pending]="indicator.pending()"
        [failed]="indicator.failed()"
        [lastSyncAt]="indicator.lastSyncAt()"
      />
      @if (indicator.state() === 'failed') {
        <div class="actions">
          <button
            type="button"
            class="primary ui-btn"
            [disabled]="indicator.retrying()"
            (click)="indicator.retry()"
          >
            <span i18n="@@training.sync-sheet.retry">Tentar de Novo</span>
          </button>
          @if (indicator.failed() > 0) {
            <button type="button" class="secondary ui-btn" (click)="issues.emit()">
              <span i18n="@@training.sync-sheet.see">Ver os Recusados</span>
            </button>
          }
        </div>
      }
    </app-training-sheet>
  `,
  styles: `
    .state {
      margin: 0 0 var(--space-2);
      font-weight: 650;
    }
    .actions {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingSyncSheet {
  protected readonly indicator = inject(TrainingSyncIndicator);
  readonly closed = output<void>();
  readonly issues = output<void>();
  protected readonly heading = $localize`:@@training.sync-sheet.title:Sincronização`;

  protected readonly text = computed(() => {
    switch (this.indicator.state()) {
      case 'busy':
        return $localize`:@@training.sync-sheet.busy:Sincronizando agora.`;
      case 'pending':
        return $localize`:@@training.sync-sheet.pending:Aguardando envio. Vai sozinho assim que der.`;
      case 'offline':
        return $localize`:@@training.sync-sheet.offline:Sem rede: usando o que está no aparelho.`;
      case 'failed':
        return this.indicator.failed() > 0
          ? $localize`:@@training.sync-sheet.refused:O servidor recusou alterações.`
          : $localize`:@@training.sync-sheet.unreachable:Sem resposta do servidor: usando o que está no aparelho.`;
      default:
        return $localize`:@@training.sync-sheet.ok:Tudo sincronizado.`;
    }
  });
}
