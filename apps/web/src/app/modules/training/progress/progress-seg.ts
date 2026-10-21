import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface SegOption<T extends string = string> {
  readonly id: T;
  readonly label: string;
}

/**
 * Controle segmentado de escolha única (métrica e período do gráfico): uma fileira de botões do mesmo tamanho com
 * `aria-pressed` no que está ligado. O visual é o do seletor do topo da aba Exercícios.
 */
@Component({
  selector: 'app-progress-seg',
  template: `
    <div class="seg" role="group" [attr.aria-label]="label()">
      @for (option of options(); track option.id) {
        <button
          type="button"
          [attr.aria-pressed]="option.id === selected()"
          (click)="selectedChange.emit(option.id)"
        >
          {{ option.label }}
        </button>
      }
    </div>
  `,
  styleUrl: './progress-seg.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgressSeg {
  readonly options = input.required<readonly SegOption[]>();
  readonly selected = input.required<string>();
  /** O nome do conjunto, lido pelo leitor de tela ("Período do gráfico"). */
  readonly label = input.required<string>();
  readonly selectedChange = output<string>();
}
