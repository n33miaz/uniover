import { ChangeDetectionStrategy, Component, input } from '@angular/core';
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
        @if (withSwitch()) {
          <span appSkeleton class="sk-switch"></span>
        }
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
        @if (withSwitch()) {
          <div class="sk-actions">
            <span appSkeleton class="sk-start"></span>
            <span appSkeleton class="sk-start"></span>
          </div>
        }
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
    .sk-switch {
      display: block;
      height: 52px;
      border-radius: var(--radius);
    }
    .sk-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-2);
    }
    .sk-actions .sk-start {
      height: 52px;
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
  /** Com o seletor Catálogo | Rotinas e os botões de baixo: a tela inteira ainda não existe (o banco abre). */
  readonly withSwitch = input(false);
  protected readonly label = $localize`:@@training.routines.loading:Carregando as rotinas…`;
}
