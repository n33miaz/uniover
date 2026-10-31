import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { LoadingFrame } from '../../../shared/ui/skeleton/loading-frame';
import { Skeleton } from '../../../shared/ui/skeleton/skeleton';

/**
 * O esqueleto das telas de edição enquanto o registro a editar é lido (exercício próprio, rotina, avaliação): o título
 * (o voltar já é o da barra do topo, que a casca desenha sozinha), os campos (nome do campo e a caixa) e, quando a tela real
 * tem uma lista de cartões no fim, os cartões dela, mais o par cancelar e salvar. Os formulários têm o mesmo esqueleto de
 * página; muda a quantidade de campos e de cartões.
 */
@Component({
  selector: 'app-training-form-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label()">
      <div class="sk-form">
        <span appSkeleton class="sk-title"></span>
        @for (field of fieldItems(); track field) {
          <div class="sk-field">
            <span appSkeleton class="sk-field-label"></span>
            <span appSkeleton class="sk-field-input"></span>
          </div>
        }
        @if (rows() > 0) {
          <div class="sk-cards">
            @for (row of rowItems(); track row) {
              <span appSkeleton class="sk-card"></span>
            }
          </div>
          <span appSkeleton class="sk-add"></span>
        }
        <div class="sk-actions">
          <span appSkeleton class="sk-action"></span>
          <span appSkeleton class="sk-action sk-wide"></span>
        </div>
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk-form {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      max-width: 40rem;
      margin-inline: auto;
    }
    .sk-title {
      display: block;
      width: 45%;
      height: 24px;
    }
    .sk-field {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .sk-field-label {
      display: block;
      width: 30%;
      height: 14px;
      min-height: 0;
    }
    .sk-field-input {
      display: block;
      height: 48px;
      border-radius: var(--radius-sm);
    }
    .sk-cards {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .sk-card {
      display: block;
      height: 64px;
      border-radius: var(--radius);
    }
    .sk-add {
      display: block;
      height: var(--tap);
      border-radius: var(--radius);
    }
    .sk-actions {
      display: grid;
      grid-template-columns: 1fr 1.5fr;
      gap: var(--space-2);
    }
    .sk-action {
      display: block;
      height: var(--tap);
      border-radius: var(--radius);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingFormSkeleton {
  readonly label = input.required<string>();
  readonly fields = input(4);
  readonly rows = input(0);

  protected readonly fieldItems = computed(() =>
    Array.from({ length: this.fields() }, (_, index) => index),
  );
  protected readonly rowItems = computed(() =>
    Array.from({ length: this.rows() }, (_, index) => index),
  );
}
