import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { LoadingFrame } from '../../../shared/ui/skeleton/loading-frame';
import { Skeleton } from '../../../shared/ui/skeleton/skeleton';

/**
 * O esqueleto do Corpo enquanto os registros são lidos do aparelho, na forma da aba aberta. Sem ele os cartões "Sem
 * Registros" e a frase de "registre seu primeiro peso" apareciam por um instante como se não houvesse dado nenhum.
 * - `summary`: o cartão do peso (valor, linha de variação, gráfico e legenda), os dois cartões de medidas, o cartão do mapa
 *   e as duas linhas de atalho, mais o botão de registrar;
 * - `records`: as três seções que se abrem (peso, perfil, medidas) e o cartão de energia.
 * As abas e o título são os reais; só o conteúdo espera.
 */
@Component({
  selector: 'app-body-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      @if (view() === 'summary') {
        <div class="sk-stack">
          <div class="sk-weight ui-card">
            <div class="sk-heading">
              <span appSkeleton class="sk-eyebrow"></span>
              <span appSkeleton class="sk-value"></span>
            </div>
            <span appSkeleton class="sk-meta"></span>
            <span appSkeleton class="sk-plot"></span>
            <span appSkeleton class="sk-caption"></span>
          </div>
          <div class="sk-signals">
            <span appSkeleton class="sk-signal"></span>
            <span appSkeleton class="sk-signal"></span>
          </div>
          <span appSkeleton class="sk-map"></span>
          <div class="sk-links">
            <span appSkeleton class="sk-link"></span>
            <span appSkeleton class="sk-link"></span>
          </div>
          <span appSkeleton class="sk-action"></span>
        </div>
      } @else {
        <div class="sk-stack">
          <ul class="ui-group ui-plain">
            @for (row of sections; track row) {
              <li class="sk-row">
                <span appSkeleton class="sk-tile"></span>
                <span class="sk-text">
                  <span appSkeleton class="sk-name"></span>
                  <span appSkeleton class="sk-sub"></span>
                </span>
              </li>
            }
          </ul>
          <span appSkeleton class="sk-energy"></span>
        </div>
      }
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
    .sk-weight {
      display: grid;
      gap: var(--space-3);
      padding: var(--space-3);
    }
    .sk-heading {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: var(--space-3);
    }
    .sk-eyebrow {
      display: block;
      width: 20%;
      height: 14px;
      min-height: 0;
    }
    .sk-value {
      display: block;
      width: 36%;
      height: 40px;
    }
    .sk-meta {
      display: block;
      width: 45%;
      height: 14px;
      min-height: 0;
    }
    .sk-plot {
      display: block;
      height: 172px;
      border-radius: var(--radius);
    }
    .sk-caption {
      display: block;
      width: 60%;
      height: 12px;
      min-height: 0;
    }
    .sk-signals {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-2);
    }
    .sk-signal {
      display: block;
      height: 104px;
      border-radius: var(--radius-sm);
    }
    .sk-map {
      display: block;
      height: 420px;
      border-radius: var(--radius);
    }
    .sk-links {
      display: flex;
      flex-direction: column;
    }
    .sk-link {
      display: block;
      height: var(--tap);
      border-radius: 0;
    }
    .sk-link + .sk-link {
      margin-top: 1px;
    }
    .sk-action {
      display: block;
      height: var(--tap);
      border-radius: var(--radius);
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
    .sk-text {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: var(--space-2);
    }
    .sk-name {
      display: block;
      width: 45%;
      height: 16px;
      min-height: 0;
    }
    .sk-sub {
      display: block;
      width: 30%;
      height: 12px;
      min-height: 0;
    }
    .sk-energy {
      display: block;
      height: 220px;
      border-radius: var(--radius);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodySkeleton {
  readonly view = input<'summary' | 'records'>('summary');

  protected readonly label = $localize`:@@training.body.loading:Carregando seus registros…`;
  protected readonly sections = [1, 2, 3];
}

/** As fotos de progresso enquanto a lista é lida do aparelho: a mesma grade de duas colunas dos cartões de foto. */
@Component({
  selector: 'app-body-photos-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      <div class="sk-grid">
        @for (card of cards; track card) {
          <div class="sk-card">
            <span appSkeleton class="sk-image"></span>
            <span appSkeleton class="sk-date"></span>
          </div>
        }
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk-grid {
      display: .sk-grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-2);
    }
    .sk-card {
      display: .sk-grid;
      gap: var(--space-1);
      padding: var(--space-2);
      border: 1px solid var(--a-line);
      border-radius: var(--radius-sm);
    }
    .sk-image {
      display: block;
      height: 150px;
      border-radius: var(--radius-sm);
    }
    .sk-date {
      display: block;
      width: 55%;
      height: 14px;
      min-height: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodyPhotosSkeleton {
  protected readonly label = $localize`:@@training.body.photos.loading:Carregando as fotos…`;
  protected readonly cards = [1, 2];
}

/** O miolo do cartão de energia enquanto os lançamentos do dia são lidos: o total e as três somas (proteína, carboidratos, gorduras). */
@Component({
  selector: 'app-body-meals-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      <div class="sk-meals">
        <span appSkeleton class="sk-total"></span>
        <div class="sk-macros">
          <span appSkeleton class="sk-macro"></span>
          <span appSkeleton class="sk-macro"></span>
          <span appSkeleton class="sk-macro"></span>
        </div>
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk-meals {
      display: grid;
      gap: var(--space-3);
    }
    .sk-total {
      display: block;
      width: 50%;
      height: 28px;
    }
    .sk-macros {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--space-2);
    }
    .sk-macro {
      display: block;
      height: 52px;
      border-radius: var(--radius-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodyMealsSkeleton {
  protected readonly label = $localize`:@@training.body.energy.meals-loading:Lendo seus lançamentos locais…`;
}
