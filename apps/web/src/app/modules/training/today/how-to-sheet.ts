import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { LocalExercise } from '../data/catalog/exercise';
import { ExerciseCreditLine } from '../illustrations/exercise-credit-line';
import { ExerciseIllustration } from '../illustrations/exercise-illustration';
import { illustrationFor } from '../illustrations/illustration-map';
import { TrainingSheet } from '../shell/training-sheet';

/**
 * Folha "Como fazer": a ilustração do exercício ampliada (as duas poses), o crédito dela e o passo a passo. É o que abre
 * quando se toca na miniatura ao lado do nome. Exercício sem arte mostra só o texto; sem texto nem arte a folha diz isso.
 */
@Component({
  selector: 'app-how-to-sheet',
  imports: [TrainingSheet, ExerciseIllustration, ExerciseCreditLine],
  template: `
    <app-training-sheet [heading]="exercise().name" (closed)="closed.emit()">
      @if (hasArt()) {
        <div class="art">
          <app-exercise-illustration [slug]="exercise().slug" [name]="exercise().name" />
          <app-exercise-credit-line />
        </div>
      }
      @if (exercise().instructions.length > 0) {
        <h3 class="ui-section-label" i18n="@@training.howto.steps">Passo a Passo</h3>
        <ol class="steps">
          @for (step of exercise().instructions; track $index) {
            <li>{{ step }}</li>
          }
        </ol>
      } @else {
        <p class="none" i18n="@@training.howto.none">Este exercício ainda não tem passo a passo.</p>
      }
    </app-training-sheet>
  `,
  styles: `
    .art {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-2);
    }
    .steps {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      margin: 0;
      padding-left: var(--space-5);
    }
    .none {
      margin: 0;
      color: var(--a-ink2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HowToSheet {
  readonly exercise = input.required<LocalExercise>();
  readonly closed = output<void>();

  protected readonly hasArt = computed(() => illustrationFor(this.exercise().slug) !== undefined);
}
