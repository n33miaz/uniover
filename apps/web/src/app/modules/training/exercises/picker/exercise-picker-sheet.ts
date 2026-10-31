import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { CatalogQuery, CatalogRepository } from '../../data/catalog/catalog-repository';
import type { LocalExercise } from '../../data/catalog/exercise';
import { MUSCLE_GROUP_IDS, muscleGroupLabel } from '../../domain/taxonomy';
import { ChipOption, TrainingChips } from '../../shell/training-chips';
import { TrainingGlyph } from '../../shell/training-glyph';
import { TrainingSheet } from '../../shell/training-sheet';
import { ExerciseRowBody } from '../exercise-row-body';
import { TrainingRowsSkeleton } from '../../shell/training-rows-skeleton';

/** Quantas linhas a folha mostra de cada vez; a busca estreita o resto. */
export const PICKER_PAGE_SIZE = 50;

/**
 * Folha "Adicionar exercício": a mesma lista do catálogo, com busca e grupo, para escolher um exercício e levá-lo para
 * onde a pessoa estava (o editor de rotina). Um toque numa linha escolhe e fecha; ela não altera nada por conta
 * própria, só avisa qual foi escolhido.
 */
@Component({
  selector: 'app-exercise-picker-sheet',
  imports: [TrainingSheet, TrainingChips, TrainingGlyph, ExerciseRowBody, TrainingRowsSkeleton],
  template: `
    <app-training-sheet [heading]="heading" [dismissLabel]="cancelLabel" (closed)="closed.emit()">
      <div class="tools">
        <div class="search">
          <label
            for="picker-search"
            class="ui-visually-hidden"
            i18n="@@training.picker.search-label"
            >Buscar exercício</label
          >
          <app-training-glyph class="search-icon" name="search" />
          <input
            id="picker-search"
            class="ui-input"
            type="search"
            [attr.enterkeyhint]="'search'"
            autocomplete="off"
            [attr.autocapitalize]="'off'"
            spellcheck="false"
            placeholder="Buscar exercício"
            i18n-placeholder="@@training.picker.search-placeholder"
            [value]="text()"
            (input)="text.set($any($event.target).value)"
          />
        </div>
        <app-training-chips
          [options]="groupOptions"
          [selected]="group()"
          [label]="groupFilterLabel"
          (selectedChange)="group.set($event)"
        />
      </div>

      @if (!ready()) {
        <app-training-rows-skeleton [label]="loadingLabel" [rows]="5" [thumb]="true" />
      } @else if (results().length === 0) {
        <p class="none" role="status" i18n="@@training.picker.none">Nenhum exercício achado.</p>
      } @else {
        <ul class="list ui-group ui-plain">
          @for (exercise of shown(); track exercise.id) {
            <li>
              <button type="button" class="ui-row" (click)="pick(exercise)">
                <app-exercise-row-body [exercise]="exercise" [withLast]="false" />
                <app-training-glyph class="add" name="plus" />
              </button>
            </li>
          }
        </ul>
        @if (hidden() > 0) {
          <button
            type="button"
            class="secondary ui-btn block"
            (click)="limit.update((n) => n + pageSize)"
          >
            <span i18n="@@training.picker.more">Mostrar Mais ({{ hidden() }})</span>
          </button>
        }
      }
    </app-training-sheet>
  `,
  styleUrl: './exercise-picker-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExercisePickerSheet {
  protected readonly loadingLabel = $localize`:@@training.picker.loading:Carregando os exercícios…`;
  private readonly catalog = inject(CatalogRepository);
  private readonly sheet = viewChild.required(TrainingSheet);

  readonly picked = output<LocalExercise>();
  readonly closed = output<void>();

  protected readonly heading = $localize`:@@training.picker.title:Adicionar Exercício`;
  protected readonly cancelLabel = $localize`:@@training.picker.cancel:Cancelar`;
  protected readonly groupFilterLabel = $localize`:@@training.filter.group:Filtrar por grupo muscular`;
  protected readonly groupOptions: readonly ChipOption[] = [
    { id: '', label: $localize`:@@training.filter.all:Todos` },
    ...MUSCLE_GROUP_IDS.map((id) => ({ id, label: muscleGroupLabel(id) })),
  ];
  protected readonly pageSize = PICKER_PAGE_SIZE;

  protected readonly text = signal('');
  protected readonly group = signal('');
  protected readonly limit = signal(PICKER_PAGE_SIZE);
  protected readonly results = signal<readonly LocalExercise[]>([]);
  protected readonly ready = signal(false);
  protected readonly shown = computed(() => this.results().slice(0, this.limit()));
  protected readonly hidden = computed(() => this.results().length - this.shown().length);

  private ticket = 0;

  constructor() {
    effect(() => {
      const query: CatalogQuery = { text: this.text(), group: this.group() || undefined };
      this.catalog.revision();
      untracked(() => {
        this.limit.set(PICKER_PAGE_SIZE);
        void this.run(query);
      });
    });
  }

  protected pick(exercise: LocalExercise): void {
    this.picked.emit(exercise);
    this.sheet().close();
  }

  private async run(query: CatalogQuery): Promise<void> {
    const ticket = ++this.ticket;
    const rows = await this.catalog.search(query);
    if (ticket !== this.ticket) return;
    this.results.set(rows);
    this.ready.set(true);
  }
}
