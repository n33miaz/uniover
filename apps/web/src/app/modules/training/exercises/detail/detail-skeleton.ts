import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LoadingFrame } from '../../../../shared/ui/skeleton/loading-frame';
import { Skeleton } from '../../../../shared/ui/skeleton/skeleton';

/**
 * O esqueleto da ficha do exercício, na ordem da ficha pronta: as duas figuras (ilustração e músculos), as etiquetas, o
 * nome, "Adicionar a um Treino", o cartão do passo a passo e o do histórico. O voltar é o da barra do topo, que a casca
 * já desenha; o cabeçalho vazio fica só para guardar o mesmo espaço da ficha.
 */
@Component({
  selector: 'app-exercise-detail-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      <div class="sk-detail">
        <div class="sk-head"></div>
        <div class="sk-visuals">
          <span appSkeleton class="sk-figure"></span>
          <span appSkeleton class="sk-figure"></span>
        </div>
        <div class="sk-chips">
          <span appSkeleton class="sk-chip"></span>
          <span appSkeleton class="sk-chip"></span>
          <span appSkeleton class="sk-chip"></span>
        </div>
        <span appSkeleton class="sk-name"></span>
        <span appSkeleton class="sk-action"></span>
        <div class="sk-part">
          <span appSkeleton class="sk-label"></span>
          <span appSkeleton class="sk-steps"></span>
        </div>
        <div class="sk-part">
          <span appSkeleton class="sk-label"></span>
          <span appSkeleton class="sk-facts"></span>
        </div>
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk-detail {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      max-width: 40rem;
      margin-inline: auto;
    }
    .sk-visuals {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
    }
    .sk-figure {
      display: block;
      aspect-ratio: 268 / 275;
      border-radius: var(--radius);
    }
    .sk.sk-chips {
      display: flex;
      justify-content: center;
      gap: 6px;
    }
    .sk-chip {
      display: block;
      width: 72px;
      height: 28px;
      min-height: 0;
      border-radius: var(--radius-pill);
    }
    .sk-name {
      display: block;
      width: 60%;
      height: 28px;
      margin-inline: auto;
    }
    .sk-action {
      display: block;
      height: 56px;
      border-radius: var(--radius);
    }
    .sk-part {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .sk-label {
      display: block;
      width: 32%;
      height: 14px;
      min-height: 0;
    }
    .sk-steps {
      display: block;
      height: 180px;
      border-radius: var(--radius);
    }
    .sk-facts {
      display: block;
      height: 150px;
      border-radius: var(--radius);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExerciseDetailSkeleton {
  protected readonly label = $localize`:@@training.detail.loading:Carregando o exercício…`;
}
