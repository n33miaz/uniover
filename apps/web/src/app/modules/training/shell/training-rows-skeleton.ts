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
      @if (head() === 'library') {
        <!-- O topo da biblioteca como ele é: seletor Catálogo | Rotinas, busca com filtro, grupos e a contagem. -->
        <div class="sk-head">
          <span appSkeleton class="sk-switch"></span>
          <div class="sk-tools">
            <span appSkeleton class="sk-search"></span>
            <span appSkeleton class="sk-filter"></span>
          </div>
          <div class="sk-chips">
            @for (chip of chips; track chip) {
              <span appSkeleton class="sk-pill"></span>
            }
          </div>
          <span appSkeleton class="sk-count"></span>
        </div>
      }
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
    .sk-head {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      margin-bottom: var(--space-3);
    }
    .sk-switch {
      display: block;
      height: 52px;
      border-radius: var(--radius);
    }
    .sk-tools {
      display: flex;
      gap: var(--space-2);
    }
    .sk-search {
      display: block;
      flex: 1 1 auto;
      height: 48px;
      border-radius: var(--radius);
    }
    .sk-filter {
      display: block;
      flex: none;
      width: 48px;
      height: 48px;
      border-radius: var(--radius);
    }
    .sk-chips {
      display: flex;
      gap: var(--space-2);
      overflow: hidden;
    }
    .sk-pill {
      display: block;
      flex: none;
      width: 72px;
      height: 40px;
      border-radius: 999px;
    }
    .sk-count {
      display: block;
      width: 38%;
      height: 40px;
      border-radius: var(--radius);
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
  /** `library`: também o topo da biblioteca (seletor, busca, grupos e contagem), quando a tela inteira ainda não existe. */
  readonly head = input<'library' | null>(null);
  protected readonly chips = [1, 2, 3, 4, 5];

  protected readonly items = computed(() =>
    Array.from({ length: this.rows() }, (_, index) => index),
  );
}
