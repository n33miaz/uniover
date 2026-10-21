import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { InstallHintService } from '../../../core/pwa/install-hint.service';
import { SessionRepository } from '../data/sessions/session-repository';
import { TrainingSync } from '../data/sync/training-sync';
import { SyncIssuesSheet } from './sync-issues-sheet';
import { TrainingSyncLine } from './training-sync-line';

/**
 * Casca do módulo Treino: a linha de sincronização no topo de toda tela e, embaixo dela, a tela da aba. Os dados do
 * módulo (`provideTrainingData`) vêm dos `providers` da rota; ao entrar, o puxador é ligado (uma vez) e o que o
 * servidor tem de novo chega ao banco local sem a tela esperar por ele. A folha das alterações recusadas só existe
 * enquanto a pessoa a pede, e só se há o que mostrar.
 *
 * Também sabe quando há um treino aberto neste aparelho (relê a cada gravação) e, enquanto houver, pede que a folha
 * "Atalho na tela de início" não abra sozinha: um aviso no meio de uma série atrapalha mais que ajuda, e um treino
 * restaurado ao abrir o app seria interrompido 3 s depois. A linha de sincronização também deixa de sugerir a instalação.
 */
@Component({
  selector: 'app-training-page',
  imports: [RouterOutlet, TrainingSyncLine, SyncIssuesSheet],
  template: `
    <app-training-sync-line [live]="live()" (issues)="issuesOpen.set(true)" />
    <router-outlet />
    @if (issuesOpen()) {
      <app-sync-issues-sheet (closed)="issuesOpen.set(false)" />
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingPage {
  private readonly sessions = inject(SessionRepository);
  private readonly install = inject(InstallHintService);

  protected readonly issuesOpen = signal(false);
  /** Há um treino aberto neste aparelho. */
  protected readonly live = signal(false);

  constructor() {
    // Sem esperar: o `start()` hidrata a fila e puxa em segundo plano; a tela lê do banco local desde já.
    void inject(TrainingSync).start();

    // Relê o treino aberto a cada gravação do aparelho (iniciar, série, encerrar, descartar). A resposta mais velha, que
    // chega depois de uma mais nova, é descartada.
    let latest = 0;
    effect(() => {
      this.sessions.revision();
      const turn = ++latest;
      void this.sessions.activeSession().then(
        (active) => {
          if (turn === latest) this.live.set(active !== undefined);
        },
        () => undefined,
      );
    });

    // Treino aberto: a folha de instalação não abre sozinha. Ao encerrar (ou sair do módulo) o pedido é solto.
    effect((onCleanup) => {
      if (!this.live()) return;
      onCleanup(untracked(() => this.install.holdAuto()));
    });
  }
}
