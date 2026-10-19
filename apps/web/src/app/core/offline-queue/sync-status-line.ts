import { Component, computed, input } from '@angular/core';

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

/**
 * Linha de status da sincronização, só apresentacional (os dados entram por `input`; quem usa a liga ao
 * `OfflineQueue`). Mostra os itens ainda não sincronizados, os com erro e, quando não há nenhum dos dois, a hora
 * da última sincronização. A região `role="status"` existe sempre, para o leitor de tela anunciar as mudanças.
 */
@Component({
  selector: 'app-sync-status-line',
  template: `
    <p class="line" role="status">
      @if (pendingText(); as value) {
        <span class="pending">{{ value }}</span>
      }
      @if (pendingText() && failedText()) {
        <span class="sep" aria-hidden="true"> · </span>
      }
      @if (failedText(); as value) {
        <span class="error">{{ value }}</span>
      }
      @if (syncedText(); as value) {
        <span class="synced">{{ value }}</span>
      }
    </p>
  `,
  styles: `
    .line {
      margin: 0;
      font-size: 0.85rem;
      color: var(--a-muted, inherit);
    }
    .error {
      color: var(--a-danger, inherit);
      font-weight: 600;
    }
  `,
})
export class SyncStatusLine {
  /** Itens que ainda não chegaram ao servidor. */
  readonly pending = input(0);
  /** Itens que o servidor recusou. */
  readonly failed = input(0);
  /** Instante (ms desde 1970) da última sincronização, ou `null` se ainda não houve. */
  readonly lastSyncAt = input<number | null>(null);

  protected readonly pendingText = computed(() => {
    const pending = this.pending();
    if (pending <= 0) return '';
    return pending === 1
      ? $localize`:@@syncStatus.pendingOne:1 ainda não sincronizado`
      : $localize`:@@syncStatus.pendingMany:${pending}:count: ainda não sincronizados`;
  });

  protected readonly failedText = computed(() => {
    const failed = this.failed();
    if (failed <= 0) return '';
    return failed === 1
      ? $localize`:@@syncStatus.failedOne:1 com erro`
      : $localize`:@@syncStatus.failedMany:${failed}:count: com erro`;
  });

  /** A hora só aparece quando não há nada pendente nem com erro: senão ela contradiz o resto da linha. */
  protected readonly syncedText = computed(() => {
    const last = this.lastSyncAt();
    if (last === null || this.pending() > 0 || this.failed() > 0) return '';
    return $localize`:@@syncStatus.syncedAt:sincronizado às ${timeFormat.format(last)}:time:`;
  });
}
