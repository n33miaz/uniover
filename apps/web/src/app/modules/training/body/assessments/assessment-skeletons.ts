import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LoadingFrame } from '../../../../shared/ui/skeleton/loading-frame';
import { Skeleton } from '../../../../shared/ui/skeleton/skeleton';

/** O histórico de avaliações enquanto é lido: as linhas de registro (data, origem e quantidade de medidas), sem a seta. */
@Component({
  selector: 'app-assessments-list-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      <div class="sk-history">
        @for (row of rows; track row) {
          <div class="sk-record">
            <span appSkeleton class="sk-date"></span>
            <span appSkeleton class="sk-source"></span>
            <span appSkeleton class="sk-count"></span>
          </div>
        }
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    /* A mesma moldura da lista pronta: fio em cima, registros de 74 px com fio embaixo. */
    .sk-history {
      display: grid;
      border-top: 1px solid var(--a-line);
    }
    .sk-record {
      display: grid;
      gap: 3px;
      align-content: center;
      min-height: 74px;
      padding: var(--space-2) var(--space-4) var(--space-2) 0;
      border-bottom: 1px solid var(--a-line);
    }
    .sk-date {
      display: block;
      width: 40%;
      height: 16px;
      min-height: 0;
    }
    .sk-source {
      display: block;
      width: 55%;
      height: 12px;
      min-height: 0;
    }
    .sk-count {
      display: block;
      width: 25%;
      height: 12px;
      min-height: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssessmentsListSkeleton {
  protected readonly label = $localize`:@@training.assessments.list-loading:Carregando o histórico…`;
  protected readonly rows = [1, 2, 3];
}

/**
 * Uma avaliação enquanto é lida: o cabeçalho (etiqueta, data e origem), o cartão do contexto e o das medidas. A tela
 * real troca a página inteira, então o esqueleto leva também o cabeçalho.
 */
@Component({
  selector: 'app-assessment-detail-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      <div class="sk-detail">
        <div class="sk-head">
          <span appSkeleton class="sk-eyebrow"></span>
          <span appSkeleton class="sk-title"></span>
          <span appSkeleton class="sk-origin"></span>
        </div>
        <span appSkeleton class="sk-context"></span>
        <span appSkeleton class="sk-measures"></span>
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk-detail {
      display: grid;
      gap: var(--space-3);
    }
    .sk-head {
      display: grid;
      gap: 4px;
    }
    .sk-eyebrow {
      display: block;
      width: 30%;
      height: 12px;
      min-height: 0;
    }
    .sk-title {
      display: block;
      width: 62%;
      height: 32px;
    }
    .sk-origin {
      display: block;
      width: 45%;
      height: 14px;
      min-height: 0;
    }
    .sk-context {
      display: block;
      height: 82px;
      border-radius: var(--radius-sm);
    }
    .sk-measures {
      display: block;
      height: 260px;
      border-radius: var(--radius-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssessmentDetailSkeleton {
  protected readonly label = $localize`:@@training.assessments.detail-loading:Carregando a avaliação…`;
}

/** O formulário de avaliação enquanto o registro a editar é lido: os blocos de campos (rótulo e caixa) um sobre o outro. */
@Component({
  selector: 'app-assessment-form-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      <div class="sk-form">
        @for (group of groups; track group) {
          <div class="sk-fieldset">
            <span appSkeleton class="sk-legend"></span>
            @for (field of fields; track field) {
              <span appSkeleton class="sk-field-label"></span>
              <span appSkeleton class="sk-field-input"></span>
            }
          </div>
        }
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk-form {
      display: grid;
      gap: var(--space-3);
    }
    /* A caixa do bloco de campos da tela pronta: mesma borda e mesmo respiro. */
    .sk-fieldset {
      display: grid;
      gap: 8px;
      padding: var(--space-3);
      border: 1px solid var(--a-line);
      border-radius: var(--radius-sm);
    }
    .sk-legend {
      display: block;
      width: 50%;
      height: 16px;
      min-height: 0;
    }
    .sk-field-label {
      display: block;
      width: 35%;
      height: 14px;
      min-height: 0;
    }
    .sk-field-input {
      display: block;
      height: 44px;
      border-radius: var(--radius-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssessmentFormSkeleton {
  protected readonly label = $localize`:@@training.assessments.form-loading:Carregando a avaliação…`;
  protected readonly groups = [1, 2];
  protected readonly fields = [1, 2, 3];
}
