import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LoadingFrame } from '../../../shared/ui/skeleton/loading-frame';
import { Skeleton } from '../../../shared/ui/skeleton/skeleton';

/**
 * O esqueleto da lista de rotinas, com a forma do que vem depois: o cartão da próxima rotina (letra, nome e resumo, e o
 * botão de iniciar) e o botão "Ver todas" embaixo.
 */
@Component({
  selector: 'app-routines-list-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      <div class="sk-stack">
        <div class="sk-next-card ui-card">
          <div class="sk-main">
            <span appSkeleton class="sk-tile"></span>
            <span class="sk-text">
              <span appSkeleton class="sk-name"></span>
              <span appSkeleton class="sk-sub"></span>
            </span>
          </div>
          <span appSkeleton class="sk-start"></span>
        </div>
        <span appSkeleton class="sk-more"></span>
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk-stack {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .sk-next-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding: var(--space-4);
    }
    .sk-main {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      min-height: var(--tap);
    }
    .sk-tile {
      display: block;
      flex: none;
      width: 44px;
      height: 44px;
      border-radius: var(--radius-sm);
    }
    .sk-text {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: var(--space-2);
    }
    .sk-name {
      display: block;
      width: 55%;
      height: 16px;
    }
    .sk-sub {
      display: block;
      width: 80%;
      height: 12px;
    }
    .sk-start {
      display: block;
      height: 56px;
      border-radius: var(--radius);
    }
    .sk-more {
      display: block;
      height: var(--tap);
      border-radius: var(--radius);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoutinesListSkeleton {
  protected readonly label = $localize`:@@training.routines.loading:Carregando as rotinas…`;
}
