import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { OfflineQueue } from '../../../core/offline-queue/offline-queue';
import { InstallHintService } from '../../../core/pwa/install-hint.service';
import { TrainingSync } from '../data/sync/training-sync';

/**
 * O conselho de instalação do topo das telas do Treino. O estado da sincronização (pendente, sem rede, erro) fica no
 * anel do cabeçalho e na folha dele; aqui só existe a frase que o anel não diz.
 *
 * Num navegador do iPhone/iPad (fora da tela de início) o iOS apaga os dados do site depois de 7 dias sem uso. Se há
 * treino sem enviar e o aparelho não consegue enviá-lo agora, a linha ganha uma frase curta que leva ao passo a passo da
 * instalação (a mesma folha de Ajustes). Só então: sem pendência, com rede, no app instalado, no Android e no computador
 * não aparece nada; durante um treino aberto também não (a pessoa não pode fazer nada ali).
 */
@Component({
  selector: 'app-training-sync-line',
  template: `
    @if (installAdvice()) {
      <button type="button" class="advice" (click)="install.open()">
        <span>
          <span i18n="@@training.sync.install-advice"
            >Estes treinos estão salvos só neste navegador. Envie-os quando tiver internet; instale
            na tela de início para os próximos.</span
          >&ngsp;<span class="how" i18n="@@training.sync.install-how">Ver Como</span>
        </span>
      </button>
    }
  `,
  host: { '[hidden]': '!installAdvice()' },
  styleUrl: './training-sync-line.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingSyncLine {
  private readonly queue = inject(OfflineQueue);
  private readonly sync = inject(TrainingSync);
  private readonly connectivity = inject(ConnectivityService);

  protected readonly install = inject(InstallHintService);

  /** Há um treino aberto neste aparelho: nada de sugestão de instalação no meio dele. */
  readonly live = input(false);

  /** Há rede e o último puxar não falhou: o que se vê é o que o servidor tem. */
  private readonly reachable = computed(
    () => this.connectivity.online() && this.sync.error() === null,
  );

  /**
   * Treino parado no aparelho, sem como enviar agora (sem rede ou servidor fora), num navegador do iPhone/iPad. Com rede o
   * envio é questão de segundos e o aviso só piscaria; com o servidor recusando (`failed`), quem fala é o anel.
   */
  protected readonly installAdvice = computed(
    () =>
      this.queue.pendingCount() > 0 &&
      this.queue.failedCount() === 0 &&
      !this.reachable() &&
      !this.live() &&
      this.install.iosNotInstalled(),
  );
}
