import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
  inject,
  signal,
} from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { TrainingSync } from '../data/sync/training-sync';
import { SyncIssuesSheet } from './sync-issues-sheet';
import { TrainingSyncLine } from './training-sync-line';

/**
 * Casca do módulo Treino: a linha de sincronização no topo de toda tela e, embaixo dela, a tela da aba. Os dados do
 * módulo (`provideTrainingData`) vêm dos `providers` da rota; ao entrar, o puxador é ligado (uma vez) e o que o
 * servidor tem de novo chega ao banco local sem a tela esperar por ele. A folha das alterações recusadas só existe
 * enquanto a pessoa a pede, e só se há o que mostrar.
 */
@Component({
  selector: 'app-training-page',
  imports: [RouterOutlet, TrainingSyncLine, SyncIssuesSheet],
  template: `
    <app-training-sync-line (issues)="issuesOpen.set(true)" />
    <router-outlet />
    @if (issuesOpen()) {
      <app-sync-issues-sheet (closed)="issuesOpen.set(false)" />
    }
  `,
  // Sem encapsulamento de propósito: a segunda regra mira o documento (html e body), que o estilo encapsulado não alcança.
  encapsulation: ViewEncapsulation.None,
  styles: `
    app-training-page {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }

    /*
     * A barra de abas da casca é "sticky", mas o estilo global põe "overflow-x: hidden" em html e body: o body vira o
     * contêiner de rolagem (que nunca rola, pois cresce com o conteúdo) e a barra não gruda na tela. Com "clip" o corte
     * lateral continua e o body deixa de ser contêiner de rolagem. Vale só enquanto uma tela do Treino está aberta.
     */
    html:has(app-training-page),
    body:has(app-training-page) {
      overflow-x: clip;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingPage {
  protected readonly issuesOpen = signal(false);

  constructor() {
    // Sem esperar: o `start()` hidrata a fila e puxa em segundo plano; a tela lê do banco local desde já.
    void inject(TrainingSync).start();
  }
}
