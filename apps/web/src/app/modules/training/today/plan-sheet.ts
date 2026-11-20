import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { LocalExercise } from '../data/catalog/exercise';
import { ExerciseChooserSheet } from './exercise-chooser-sheet';
import { LiveStore } from './live-store';
import { TrainingGlyph } from '../shell/training-glyph';
import { TrainingSheet } from '../shell/training-sheet';
import type { LiveEntry } from './live-plan';
import { TodayGlyph } from './today-glyph';

/**
 * Folha "Exercícios do treino": a rotina de hoje de cima a baixo, com o que já foi feito, o que foi pulado e o que foi
 * acrescentado. É o caminho para voltar a um exercício, fazer mais uma série de um que já acabou, ou trazer de volta um
 * que foi pulado: um toque na linha o põe em foco. Não altera nada por conta própria.
 */
@Component({
  selector: 'app-plan-sheet',
  imports: [TrainingSheet, TrainingGlyph, TodayGlyph, ExerciseChooserSheet],
  template: `
    @if (swapExercise(); as exercise) {
      <app-exercise-chooser-sheet
        [heading]="swapHeading"
        [similarTo]="exercise"
        [excludeIds]="swapExcluded()"
        (picked)="pickSwap($event)"
        (closed)="swapKey.set(null)"
      />
    } @else {
      <app-training-sheet [heading]="heading" (closed)="closed.emit()">
        @if (failed()) {
          <p role="status" class="ui-notice warn" i18n="@@training.plan.change-failed">
            A alteração não foi salva.
          </p>
        }
        <button sheetAction type="button" class="secondary ui-btn" (click)="add.emit()">
          <app-training-glyph name="plus" />
          <span i18n="@@training.plan.add">Adicionar Exercício</span>
        </button>
        <ul class="list ui-group ui-plain">
          @for (entry of entries(); track entry.key; let index = $index) {
            <li>
              <button type="button" class="ui-row" (click)="chosen.emit(entry.key)">
                <span class="ui-tile" [class.off]="entry.skipped">
                  @if (entry.skipped) {
                    <app-today-glyph name="skip" />
                  } @else if (isComplete(entry)) {
                    <app-training-glyph name="check" />
                  } @else if (entry.extra) {
                    <app-training-glyph name="plus" />
                  } @else {
                    {{ index + 1 }}
                  }
                </span>
                <span class="ui-row-text">
                  <span class="ui-row-title">{{
                    names().get(entry.exerciseId) ?? fallbackName
                  }}</span>
                  <span class="ui-row-sub">{{ detail(entry) }}</span>
                </span>
                @if (entry.key === focusKey()) {
                  <span class="ui-chip accent" i18n="@@training.plan.now">Agora</span>
                }
              </button>
              @if (entry.itemId !== null && !entry.skipped && !isComplete(entry)) {
                <div
                  class="row-actions"
                  role="group"
                  [attr.aria-label]="names().get(entry.exerciseId) ?? fallbackName"
                >
                  <button
                    type="button"
                    class="secondary ui-btn"
                    (click)="finish(entry.key)"
                    [disabled]="saving()"
                  >
                    <span i18n="@@training.plan.finish-item">Finalizar exercício</span>
                  </button>
                  @if (live.canSwapEntry(entry.key)) {
                    <button
                      type="button"
                      class="secondary ui-btn"
                      (click)="openSwap(entry.key)"
                      [disabled]="saving()"
                    >
                      <span i18n="@@training.plan.swap-item">Ver similares</span>
                    </button>
                  }
                </div>
              }
            </li>
          }
        </ul>
      </app-training-sheet>
    }
  `,
  styles: `
    .list {
      margin: 0;
    }
    .row-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      padding: 0 var(--space-3) var(--space-2);
    }
    .ui-tile.off {
      opacity: 0.55;
    }
    /* A folha abre com o foco na primeira linha: o anel fica por dentro dela (por fora, o grupo o cortaria numa linha solta). */
    .ui-row:focus-visible {
      outline-offset: -3px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanSheet {
  readonly entries = input.required<readonly LiveEntry[]>();
  /** Nome de cada exercício, por id. */
  readonly names = input.required<ReadonlyMap<string, string>>();
  readonly focusKey = input<string | null>(null);
  readonly finishedFocus = output<void>();

  readonly chosen = output<string>();
  readonly add = output<void>();
  readonly closed = output<void>();

  protected readonly heading = $localize`:@@training.plan.title:Exercícios do Treino`;
  protected readonly live = inject(LiveStore);
  protected readonly saving = signal(false);
  protected readonly failed = signal(false);
  protected readonly swapKey = signal<string | null>(null);
  protected readonly swapHeading = $localize`:@@training.plan.similar-title:Exercícios Similares`;
  protected readonly swapExercise = computed(() => {
    const entry = this.entries().find((candidate) => candidate.key === this.swapKey());
    return entry ? this.live.exercises().get(entry.exerciseId) : undefined;
  });
  protected readonly swapExcluded = computed(() =>
    this.entries()
      .filter((entry) => entry.key !== this.swapKey())
      .flatMap((entry) => [entry.exerciseId, entry.planExerciseId]),
  );
  protected readonly fallbackName = $localize`:@@training.plan.unknown:Exercício removido`;

  protected async finish(key: string): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    const wasFocused = key === this.focusKey();
    try {
      const saved = await this.live.finishExercise(key);
      this.failed.set(!saved);
      if (saved && wasFocused) this.finishedFocus.emit();
    } finally {
      this.saving.set(false);
    }
  }

  protected openSwap(key: string): void {
    this.failed.set(false);
    this.swapKey.set(key);
  }

  protected async pickSwap(exercise: LocalExercise): Promise<void> {
    const key = this.swapKey();
    if (key === null) return;
    try {
      const outcome = await this.live.swapEntry(key, exercise);
      this.failed.set(outcome !== 'swapped' && outcome !== 'restored');
    } catch {
      this.failed.set(true);
    }
  }

  protected isComplete(entry: LiveEntry): boolean {
    return (
      entry.finished === true || (entry.targetSets !== null && entry.doneSets >= entry.targetSets)
    );
  }

  protected detail(entry: LiveEntry): string {
    const done = entry.doneSets;
    if (entry.finished) {
      return $localize`:@@training.plan.finished:finalizado · toque para reabrir`;
    }
    if (entry.skipped) {
      return $localize`:@@training.plan.skipped:pulado · toque para voltar a incluir`;
    }
    if (entry.targetSets === null) {
      return done === 1
        ? $localize`:@@training.plan.extra-one:fora da rotina · 1 série`
        : $localize`:@@training.plan.extra-many:fora da rotina · ${done}:count: séries`;
    }
    const target = entry.targetSets;
    const progress = $localize`:@@training.plan.progress:${done}:done: de ${target}:target: séries`;
    const parts = [progress];
    if (this.isComplete(entry))
      parts.push($localize`:@@training.plan.more:toque para fazer mais uma`);
    if (entry.swapped) parts.push($localize`:@@training.plan.swapped:trocado só hoje`);
    return parts.join(' · ');
  }
}
