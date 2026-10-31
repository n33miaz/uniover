import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { LoadingFrame } from '../../../../shared/ui/skeleton/loading-frame';
import { Skeleton } from '../../../../shared/ui/skeleton/skeleton';

/** O esqueleto do mapa corporal: o cartão da figura (na altura da figura pronta) e a legenda das cores embaixo. */
@Component({
  selector: 'app-body-map-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      @if (withHead()) {
        <!-- O título e o seletor Frente | Costas, quando a tela inteira ainda não existe (o banco abre). -->
        <div class="sk-head">
          <span appSkeleton class="sk-title"></span>
          <span appSkeleton class="sk-faces"></span>
        </div>
      }
      <div class="sk-stage ui-card">
        <span appSkeleton class="sk-figure"></span>
        <div class="sk-legend">
          <span appSkeleton class="sk-chip"></span>
          <span appSkeleton class="sk-chip"></span>
          <span appSkeleton class="sk-chip"></span>
        </div>
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      margin-bottom: var(--space-3);
    }
    .sk-title {
      display: block;
      width: 46%;
      height: 32px;
    }
    .sk-faces {
      display: block;
      width: 46%;
      height: 52px;
      border-radius: var(--radius);
    }
    .sk-stage {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-3) var(--space-2);
    }
    /* A altura é a da figura pronta (a variável vem da página), para o cartão não crescer quando o desenho entra. */
    .sk-figure {
      display: block;
      height: var(--figure-height, 320px);
      border-radius: var(--radius);
    }
    .sk-legend {
      display: flex;
      justify-content: center;
      gap: var(--space-3);
      padding-top: var(--space-3);
    }
    .sk-chip {
      display: block;
      width: 64px;
      height: 14px;
      min-height: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodyMapSkeleton {
  /** Com o título e o seletor de lado: a tela inteira ainda não existe. */
  readonly withHead = input(false);
  protected readonly label = $localize`:@@training.map.loading:Carregando o mapa corporal…`;
}
