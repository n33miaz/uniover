import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { LoadingFrame } from '../../../shared/ui/skeleton/loading-frame';
import { Skeleton } from '../../../shared/ui/skeleton/skeleton';

/**
 * O esqueleto das listas de linhas do módulo (exercícios do catálogo, do seletor, modelos, programas): a mesma caixa de
 * grupo da lista real, com a miniatura à esquerda e duas linhas de texto. `thumb` pede a miniatura grande dos exercícios
 * (64 px); sem ela, o quadrado pequeno dos ícones das outras listas.
 */
@Component({
  selector: 'app-training-rows-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label()">
      <ul class="ui-group ui-plain">
        @for (row of items(); track row) {
          <li class="sk-row">
            <span appSkeleton class="sk-tile" [class.sk-thumb]="thumb()"></span>
            <span class="sk-text">
              <span appSkeleton class="sk-name"></span>
              <span appSkeleton class="sk-sub"></span>
            </span>
          </li>
        }
      </ul>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    ul {
      margin: 0;
    }
    .sk-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      min-height: 60px;
      padding: var(--space-3) var(--space-4);
    }
    .sk-tile {
      display: block;
      flex: none;
      width: 44px;
      height: 44px;
      border-radius: var(--radius-sm);
    }
    .sk-tile.sk-thumb {
      width: 64px;
      height: 64px;
    }
    .sk-text {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: var(--space-2);
      min-width: 0;
    }
    .sk-name {
      display: block;
      width: 62%;
      height: 16px;
    }
    .sk-sub {
      display: block;
      width: 40%;
      height: 12px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingRowsSkeleton {
  readonly label = input.required<string>();
  readonly rows = input(5);
  readonly thumb = input(false);

  protected readonly items = computed(() =>
    Array.from({ length: this.rows() }, (_, index) => index),
  );
}
