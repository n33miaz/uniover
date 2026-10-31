import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { matchesTokens, normalizeText, searchTokens } from '../domain/text-search';
import { TrainingGlyph } from '../shell/training-glyph';
import { TrainingSheet } from '../shell/training-sheet';

/** Um exercício com histórico, pronto para a lista: o nome e o texto da última vez ("18/10"). */
export interface HistoryChoice {
  readonly id: string;
  readonly name: string;
  readonly last: string;
}

/**
 * Folha "Outro exercício": só os exercícios que têm histórico de carga (os que o gráfico consegue mostrar), do treinado
 * mais recentemente ao mais antigo, com busca por nome. Um toque numa linha escolhe e fecha; ela não grava nada.
 */
@Component({
  selector: 'app-exercise-history-sheet',
  imports: [TrainingSheet, TrainingGlyph],
  template: `
    <app-training-sheet [heading]="heading" [dismissLabel]="cancelLabel" (closed)="closed.emit()">
      <div class="search">
        <label
          for="history-search"
          class="ui-visually-hidden"
          i18n="@@training.progress.pick.search-label"
          >Buscar exercício com histórico</label
        >
        <app-training-glyph class="search-icon" name="search" />
        <input
          id="history-search"
          class="ui-input"
          type="search"
          [attr.enterkeyhint]="'search'"
          autocomplete="off"
          [attr.autocapitalize]="'off'"
          spellcheck="false"
          placeholder="Buscar exercício"
          i18n-placeholder="@@training.progress.pick.search-placeholder"
          [value]="text()"
          (input)="text.set($any($event.target).value)"
        />
      </div>

      @if (shown().length === 0) {
        <p class="none" role="status" i18n="@@training.progress.pick.none">
          Nenhum exercício com histórico achado.
        </p>
      } @else {
        <ul class="list ui-group ui-plain">
          @for (choice of shown(); track choice.id) {
            <li>
              <button type="button" class="ui-row" (click)="pick(choice.id)">
                <span class="ui-row-text">
                  <span class="ui-row-title">{{ choice.name }}</span>
                  <span class="ui-row-sub" i18n="@@training.progress.pick.last"
                    >último treino em {{ choice.last }}</span
                  >
                </span>
              </button>
            </li>
          }
        </ul>
      }
    </app-training-sheet>
  `,
  styleUrl: './exercise-history-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExerciseHistorySheet {
  private readonly sheet = viewChild.required(TrainingSheet);

  readonly choices = input.required<readonly HistoryChoice[]>();
  readonly picked = output<string>();
  readonly closed = output<void>();

  protected readonly heading = $localize`:@@training.progress.pick.title:Outro Exercício`;
  protected readonly cancelLabel = $localize`:@@training.progress.pick.cancel:Cancelar`;
  protected readonly text = signal('');

  protected readonly shown = computed(() => {
    const tokens = searchTokens(this.text());
    if (tokens.length === 0) return this.choices();
    return this.choices().filter((choice) => matchesTokens(normalizeText(choice.name), tokens));
  });

  protected pick(id: string): void {
    this.picked.emit(id);
    this.sheet().close();
  }
}
