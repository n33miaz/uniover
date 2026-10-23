import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { OfflineQueue } from '../../../core/offline-queue/offline-queue';
import { SyncStatusLine } from '../../../core/offline-queue/sync-status-line';
import { InstallHintService } from '../../../core/pwa/install-hint.service';
import { TrainingSync } from '../data/sync/training-sync';
import { TrainingGlyph, TrainingGlyphName } from './training-glyph';

/**
 * A faixa de sincronização do topo das telas do Treino: aparece só quando algo espera para subir ou foi recusado e, aí,
 * diz quanto falta e, sem rede ou com o servidor fora, que o app segue com o que está guardado ("sem rede" é estado
 * normal, não erro). Em dia, atualizando ou sem rede sem nada pendente ela some: o estado fica no ícone do cabeçalho. Só ganha botão quando há o que fazer: "Sincronizar agora" (há envio pendente) ou "Ver" (o
 * servidor recusou algo e a pessoa precisa decidir).
 *
 * Num navegador do iPhone/iPad (fora da tela de início) o iOS apaga os dados do site depois de 7 dias sem uso. Se há
 * treino sem enviar e o aparelho não consegue enviá-lo agora, a linha ganha uma frase curta que leva ao passo a passo da
 * instalação (a mesma folha de Ajustes). Só então: sem pendência, com rede, no app instalado, no Android e no computador
 * não aparece nada; durante um treino aberto também não (a pessoa não pode fazer nada ali).
 */
@Component({
  selector: 'app-training-sync-line',
  imports: [SyncStatusLine, TrainingGlyph],
  template: `
    @if (visible()) {
      <div class="line" [class.warn]="!reachable()" [class.bad]="failed() > 0">
        <app-training-glyph [name]="glyph()" />
        <div class="text">
          @if (note(); as value) {
            <span class="note">{{ value }}</span>
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
    }
    @if (installAdvice()) {
      <button type="button" class="advice" (click)="install.open()">
        <span>
          <span i18n="@@training.sync.install-advice"
            >Estes treinos estão salvos só neste navegador. Envie-os quando tiver internet; instale
            na tela de início para os próximos.</span
          >&ngsp;<span class="how" i18n="@@training.sync.install-how">Ver como</span>
        </span>
      </button>
    }
  `,
  host: { '[hidden]': '!visible() && !installAdvice()' },
  styleUrl: './training-sync-line.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingSyncLine {
  private readonly queue = inject(OfflineQueue);
  private readonly sync = inject(TrainingSync);
  private readonly connectivity = inject(ConnectivityService);

  protected readonly install = inject(InstallHintService);

  /** A pessoa pediu para ver o que o servidor recusou. */
  readonly issues = output<void>();
  /** Há um treino aberto neste aparelho: nada de sugestão de instalação no meio dele. */
  readonly live = input(false);

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

  /**
   * Treino parado no aparelho, sem como enviar agora (sem rede ou servidor fora), num navegador do iPhone/iPad. Com rede o
   * envio é questão de segundos e o aviso só piscaria; com o servidor recusando (`failed`), quem manda é o botão "Ver".
   */
  protected readonly installAdvice = computed(
    () =>
      this.pending() > 0 &&
      this.failed() === 0 &&
      !this.reachable() &&
      !this.live() &&
      this.install.iosNotInstalled(),
  );

  /**
   * A faixa só existe quando há o que fazer ou decidir: envio pendente ou recusado. O resto (em dia, atualizando, sem
   * rede sem nada a enviar) fica por conta do ícone do cabeçalho, sem texto e sem gastar altura. O conselho de instalação
   * tem a sua própria fileira.
   */
  protected readonly visible = computed(() => this.failed() > 0 || this.pending() > 0);

  protected readonly glyph = computed<TrainingGlyphName>(() => {
    if (this.failed() > 0) return 'alert';
    if (!this.reachable()) return 'offline';
    if (this.pending() > 0) return 'hourglass';
    return 'check';
  });

  protected syncNow(): void {
    void this.sync.pullNow();
  }
}
