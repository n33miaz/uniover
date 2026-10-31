import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LoadingFrame } from '../../../shared/ui/skeleton/loading-frame';
import { Skeleton } from '../../../shared/ui/skeleton/skeleton';

/**
 * O esqueleto da aba Progresso, com a forma da tela pronta: a faixa de exercícios, o cartão da evolução (seletor da
 * métrica, destaque e gráfico) e o grupo das quatro seções (recordes, semana, frequência, exportar).
 */
@Component({
  selector: 'app-progress-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      <div class="sk-progress">
        <span appSkeleton class="sk-chips"></span>
        <div class="sk-card ui-card">
          <span appSkeleton class="sk-seg"></span>
          <span appSkeleton class="sk-headline"></span>
          <span appSkeleton class="sk-plot"></span>
        </div>
        <ul class="sk-sections ui-group ui-plain">
          @for (row of rows; track row) {
            <li class="sk-row"><span appSkeleton class="sk-title"></span></li>
          }
        </ul>
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk-progress {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      max-width: 40rem;
      margin-inline: auto;
    }
    .sk-chips {
      display: block;
      height: var(--tap);
      border-radius: var(--radius);
    }
    .sk-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding: var(--space-4);
    }
    .sk-seg {
      display: block;
      height: var(--tap);
      border-radius: var(--radius);
    }
    .sk-headline {
      display: block;
      width: 45%;
      height: 28px;
    }
    .sk-plot {
      display: block;
      height: 172px;
      border-radius: var(--radius);
    }
    ul {
      margin: 0;
    }
    .sk-row {
      display: flex;
      align-items: center;
      min-height: 56px;
      padding: var(--space-3) var(--space-4);
    }
    .sk-title {
      display: block;
      width: 50%;
      height: 16px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgressSkeleton {
  protected readonly label = $localize`:@@training.progress.loading:Carregando o progresso…`;
  protected readonly rows = [1, 2, 3, 4];
}

/** O espaço do gráfico da evolução enquanto a série do exercício é lida: só o desenho, o cartão em volta já é o real. */
@Component({
  selector: 'app-progress-chart-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      <span appSkeleton class="sk-plot"></span>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk-plot {
      display: block;
      min-height: 172px;
      border-radius: var(--radius);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgressChartSkeleton {
  protected readonly label = $localize`:@@training.progress.chart.loading:Carregando o gráfico…`;
}
