import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface ChipOption {
  /** Valor estável da opção (id da taxonomia); texto vazio é a opção "todos". */
  readonly id: string;
  readonly label: string;
}

/**
 * Fileira de chips de escolha única (filtro). Rola na horizontal quando não cabe e vai até a borda da tela. Cada chip
 * é um botão de 44 px de altura (a área de toque) com uma pílula de 36 px desenhada dentro, para a fileira não pesar.
 * `aria-pressed` diz qual está ligado.
 */
@Component({
  selector: 'app-training-chips',
  template: `
    <div class="row" role="group" [attr.aria-label]="label()">
      @for (option of options(); track option.id) {
        <button
          type="button"
          class="chip"
          [attr.aria-pressed]="option.id === selected()"
          (click)="selectedChange.emit(option.id)"
        >
          <span class="face">{{ option.label }}</span>
        </button>
      }
    </div>
  `,
  styleUrl: './training-chips.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingChips {
  readonly options = input.required<readonly ChipOption[]>();
  readonly selected = input<string>('');
  /** Texto lido pelo leitor de tela para o conjunto ("Filtrar por grupo muscular"). */
  readonly label = input.required<string>();
  readonly selectedChange = output<string>();
}
