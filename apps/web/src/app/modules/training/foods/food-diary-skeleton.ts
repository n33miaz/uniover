import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { LoadingFrame } from '../../../shared/ui/skeleton/loading-frame';
import { Skeleton } from '../../../shared/ui/skeleton/skeleton';

/**
 * O esqueleto do diário enquanto os lançamentos do dia são lidos: dois grupos de refeição, cada um com o título e a soma
 * na ponta, e uma linha de lançamento (nome, gramas e calorias, e a faixa das ações). O dia e o formulário de baixo já são
 * os reais; só a lista espera. Com `page` (a espera pelo banco antes de a tela existir) o esqueleto também desenha o que a
 * tela traz em volta: o título, o cartão do dia, os grupos de refeição e o formulário.
 */
@Component({
  selector: 'app-food-diary-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      @if (page()) {
        <span appSkeleton class="sk-page-title"></span>
        <span appSkeleton class="sk-day-card"></span>
        <div class="sk-bars">
          @for (bar of bars; track bar) {
            <span appSkeleton class="sk-bar"></span>
          }
        </div>
        <span appSkeleton class="sk-editor"></span>
      } @else {
        <div class="sk-groups">
          @for (group of groups; track group) {
            <div class="sk-group">
              <div class="sk-heading">
                <span appSkeleton class="sk-title"></span>
                <span appSkeleton class="sk-total"></span>
              </div>
              <div class="sk-entry">
                <span appSkeleton class="sk-name"></span>
                <span appSkeleton class="sk-detail"></span>
                <span appSkeleton class="sk-actions"></span>
              </div>
            </div>
          }
        </div>
      }
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk.sk-groups,
    .sk.sk-bars {
      display: grid;
      gap: var(--space-3);
    }
    /* As medidas da tela pronta (o título, o cartão do dia, a.sk-barra de cada refeição e o formulário). */
    .sk-page.sk-title {
      display: block;
      width: 40%;
      height: 24px;
      min-height: 0;
      margin-bottom: var(--space-3);
    }
    .sk-day-card {
      display: block;
      height: 70px;
      min-height: 0;
      margin-bottom: var(--space-3);
      border-radius: var(--radius-lg, 1rem);
    }
    .sk-bar {
      display: block;
      height: 48px;
      min-height: 0;
      border-radius: var(--radius-lg, 1rem);
    }
    .sk-editor {
      display: block;
      height: 600px;
      min-height: 0;
      margin-top: var(--space-3);
      border-radius: var(--radius-lg, 1rem);
    }
    /* A caixa é a do grupo de refeição da tela pronta (a mesma borda e o mesmo respiro), para nada pular na troca. */
    .sk-group {
      display: grid;
      gap: var(--space-2);
      padding: var(--space-3);
      border: 1px solid var(--a-line);
      border-radius: var(--radius-lg, 1rem);
      background: var(--a-surface);
    }
    .sk-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }
    .sk-title {
      display: block;
      width: 36%;
      height: 18px;
      min-height: 0;
    }
    .sk-total {
      display: block;
      width: 18%;
      height: 14px;
      min-height: 0;
    }
    .sk-entry {
      display: grid;
      gap: 0.2rem;
      padding-top: var(--space-2);
      border-top: 1px solid var(--a-line);
    }
    .sk-name {
      display: block;
      width: 55%;
      height: 16px;
      min-height: 0;
    }
    .sk-detail {
      display: block;
      width: 40%;
      height: 12px;
      min-height: 0;
    }
    .sk-actions {
      display: block;
      justify-self: end;
      width: 38%;
      height: 14px;
      min-height: 0;
      margin-block: 15px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FoodDiarySkeleton {
  /** A tela ainda nem existe: desenha também o título, o cartão do dia e o formulário. */
  readonly page = input(false);
  protected readonly label = $localize`:@@training.food.loading:Carregando lançamentos…`;
  protected readonly groups = [1, 2];
  protected readonly bars = [1, 2, 3, 4, 5];
}

/** Os resultados da busca de alimentos enquanto a consulta volta: as mesmas linhas de 52 px da lista de resultados. */
@Component({
  selector: 'app-food-search-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      <div class="sk-results">
        @for (row of rows; track row) {
          <span appSkeleton class="sk-result"></span>
        }
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk.sk-results {
      display: grid;
      gap: 0.35rem;
    }
    .sk-result {
      display: block;
      height: 52px;
      border-radius: var(--radius-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FoodSearchSkeleton {
  protected readonly label = $localize`:@@training.food.searching:Buscando…`;
  protected readonly rows = [1, 2, 3];
}
