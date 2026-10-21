import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
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
  protected readonly issuesOpen = signal(false);

  constructor() {
    // Sem esperar: o `start()` hidrata a fila e puxa em segundo plano; a tela lê do banco local desde já.
    void inject(TrainingSync).start();
  }
}
