import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { CatalogQuery, CatalogRepository } from '../data/catalog/catalog-repository';
import type { LocalExercise } from '../data/catalog/exercise';
import { ExerciseRowBody } from '../exercises/exercise-row-body';
import { MUSCLE_GROUP_IDS, muscleGroupLabel, muscleLabel } from '../domain/taxonomy';
import { ChipOption, TrainingChips } from '../shell/training-chips';
import { TrainingGlyph } from '../shell/training-glyph';
import { TrainingRowsSkeleton } from '../shell/training-rows-skeleton';
import { TrainingSheet } from '../shell/training-sheet';

/** Quantas linhas a folha mostra de cada vez; a busca estreita o resto. */
export const CHOOSER_PAGE_SIZE = 50;

/**
 * Folha para escolher um exercício durante o treino: trocar o que está em foco, acrescentar um, ou começar o treino livre.
 * Mesma lista do catálogo, com busca; ao trocar, abre já no mesmo músculo (a pessoa quer outro exercício para o mesmo
 * trabalho, porque o aparelho está ocupado). Um toque na linha escolhe e fecha; a folha não altera nada por conta própria.
 */
@Component({
  selector: 'app-exercise-chooser-sheet',
  imports: [TrainingSheet, TrainingChips, TrainingGlyph, TrainingRowsSkeleton, ExerciseRowBody],
  template: `
    <app-training-sheet [heading]="heading()" [dismissLabel]="cancelLabel" (closed)="closed.emit()">
      <div class="tools">
        <div class="search">
          <label
            for="chooser-search"
            class="ui-visually-hidden"
            i18n="@@training.chooser.search-label"
            >Buscar exercício</label
          >
          <app-training-glyph class="search-icon" name="search" />
          <input
            id="chooser-search"
            class="ui-input"
            type="search"
            [attr.enterkeyhint]="'search'"
            autocomplete="off"
            [attr.autocapitalize]="'off'"
            spellcheck="false"
            placeholder="Buscar exercício"
            i18n-placeholder="@@training.chooser.search-placeholder"
            [value]="text()"
            (input)="text.set($any($event.target).value)"
          />
        </div>
        @if (muscle() !== '') {
          <app-training-chips
            [options]="muscleOptions()"
            [selected]="scope()"
            [label]="scopeLabel"
            (selectedChange)="scope.set($event)"
          />
        } @else {
          <app-training-chips
            [options]="groupOptions"
            [selected]="group()"
            [label]="groupFilterLabel"
            (selectedChange)="group.set($event)"
          />
        }
      </div>

      @if (!ready()) {
        <app-training-rows-skeleton [label]="loadingLabel" [rows]="5" [thumb]="true" />
      } @else if (shown().length === 0) {
        <p class="none" role="status" i18n="@@training.chooser.none">Nenhum exercício achado.</p>
      } @else {
        <ul class="list ui-group ui-plain">
          @for (exercise of shown(); track exercise.id) {
            <li>
              <button type="button" class="ui-row" (click)="pick(exercise)">
                <app-exercise-row-body [exercise]="exercise" [withLast]="false" />
                <app-training-glyph class="go" name="next" />
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
            <span i18n="@@training.chooser.more">Mostrar Mais ({{ hidden() }})</span>
          </button>
        }
      }
    </app-training-sheet>
  `,
  styleUrl: './exercise-chooser-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExerciseChooserSheet {
  private readonly catalog = inject(CatalogRepository);
  private readonly sheet = viewChild.required(TrainingSheet);

  readonly heading = input.required<string>();
  /** Músculo principal em que a lista abre (o do exercício que se quer trocar); vazio abre em todos. */
  readonly muscle = input('');
  /** Exercícios que não servem (já estão na rotina): ficam fora da lista. */
  readonly excludeIds = input<readonly string[]>([]);

  readonly picked = output<LocalExercise>();
  readonly closed = output<void>();

  protected readonly cancelLabel = $localize`:@@training.chooser.cancel:Cancelar`;
  protected readonly loadingLabel = $localize`:@@training.chooser.loading:Carregando os exercícios…`;
  protected readonly scopeLabel = $localize`:@@training.chooser.scope:Quais exercícios mostrar`;
  protected readonly groupFilterLabel = $localize`:@@training.filter.group:Filtrar por grupo muscular`;
  protected readonly groupOptions: readonly ChipOption[] = [
    { id: '', label: $localize`:@@training.filter.all:Todos` },
    ...MUSCLE_GROUP_IDS.map((id) => ({ id, label: muscleGroupLabel(id) })),
  ];
  protected readonly pageSize = CHOOSER_PAGE_SIZE;

  protected readonly text = signal('');
  protected readonly group = signal('');
  /** `same`: só o músculo do exercício trocado · vazio: todos. */
  protected readonly scope = signal('same');
  protected readonly limit = signal(CHOOSER_PAGE_SIZE);
  protected readonly results = signal<readonly LocalExercise[]>([]);
  protected readonly ready = signal(false);

  protected readonly muscleOptions = computed<readonly ChipOption[]>(() => [
    { id: 'same', label: muscleLabel(this.muscle()) },
    { id: '', label: $localize`:@@training.filter.all:Todos` },
  ]);
  protected readonly filtered = computed(() => {
    const excluded = new Set(this.excludeIds());
    return this.results().filter((exercise) => !excluded.has(exercise.id));
  });
  protected readonly shown = computed(() => this.filtered().slice(0, this.limit()));
  protected readonly hidden = computed(() => this.filtered().length - this.shown().length);

  private ticket = 0;

  constructor() {
    effect(() => {
      const query: CatalogQuery = {
        text: this.text(),
        group: this.muscle() === '' ? this.group() || undefined : undefined,
        muscle: this.muscle() !== '' && this.scope() === 'same' ? this.muscle() : undefined,
      };
      this.catalog.revision();
      untracked(() => {
        this.limit.set(CHOOSER_PAGE_SIZE);
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
