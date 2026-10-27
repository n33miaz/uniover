import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { LocalExercise } from '../data/catalog/exercise';
import { equipmentLabel, muscleGroupLabel, muscleGroupOf, muscleLabel } from '../domain/taxonomy';
import { illustrationFor, illustrationUrl } from '../illustrations/illustration-map';
import { TrainingGlyph } from '../shell/training-glyph';

/**
 * O miolo de uma linha da lista de exercícios: o nome e uma linha de apoio curta ("Peito · Barra · seu último: 42,5
 * kg × 8"). Quem usa envolve com o link ou o botão da linha e põe o que vai à direita. `last`: texto da última vez,
 * `null` = sem registro, `undefined` = ainda lendo (a linha não mostra nada até saber, para não piscar).
 */
@Component({
  selector: 'app-exercise-row-body',
  imports: [TrainingGlyph],
  template: `
    <span class="thumb" aria-hidden="true">
      @if (imageUrl(); as source) {
        <img [src]="source" [alt]="''" width="44" height="44" />
      } @else {
        <app-training-glyph name="dumbbell" />
      }
    </span>
    <span class="text">
      <span class="name">{{ exercise().name }}</span>
      <span class="sub">{{ support() }}</span>
    </span>
    @if (exercise().source === 'own') {
      <span class="ui-chip accent" i18n="@@training.exercise.own">própria</span>
    }
  `,
  styleUrl: './exercise-row-body.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExerciseRowBody {
  readonly exercise = input.required<LocalExercise>();
  readonly last = input<string | null | undefined>(undefined);
  /** A lista do seletor não mostra o histórico: só o que identifica o exercício. */
  readonly withLast = input(true);

  protected readonly support = computed(() => {
    const exercise = this.exercise();
    const muscle = exercise.primaryMuscles[0];
    const group = muscle ? muscleGroupOf(muscle) : undefined;
    const parts = [
      group ? muscleGroupLabel(group) : muscle ? muscleLabel(muscle) : '',
      equipmentLabel(exercise.equipment),
    ].filter(Boolean);
    const last = this.last();
    if (this.withLast() && last !== undefined) {
      parts.push(
        last === null
          ? $localize`:@@training.exercise.no-record:sem registro`
          : $localize`:@@training.exercise.last:seu último: ${last}:last:`,
      );
    }
    return parts.join(' · ');
  });

  /** A miniatura usa somente a primeira pose de uma ilustração confirmada; no espaço curto da lista, ela não anima. */
  protected readonly imageUrl = computed(() => {
    const entry = illustrationFor(this.exercise().slug);
    return entry === undefined ? null : illustrationUrl(entry.frames[0]);
  });
}
