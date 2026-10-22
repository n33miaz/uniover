import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { MuscleId } from '../../domain/taxonomy';
import { muscleLabel } from '../../domain/taxonomy';
import {
  BODY_HEIGHT,
  BODY_OUTLINE,
  BODY_WIDTH,
  BODY_ZONES,
  type BodyFace,
} from '../body-map/body-zones';

/** Silhuetas estáticas da ficha: reaproveitam a geometria do mapa, sem os controles de seleção. */
@Component({
  selector: 'app-exercise-muscles',
  templateUrl: './exercise-muscles.html',
  styleUrl: './exercise-muscles.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExerciseMuscles {
  readonly primary = input.required<readonly MuscleId[]>();
  readonly secondary = input.required<readonly MuscleId[]>();

  protected readonly faces: readonly BodyFace[] = ['front', 'back'];
  protected readonly outline = BODY_OUTLINE;
  protected readonly viewBox = `0 0 ${BODY_WIDTH} ${BODY_HEIGHT}`;
  protected readonly zones = (face: BodyFace) => BODY_ZONES[face];

  protected isPrimary(muscle: MuscleId): boolean {
    return this.primary().includes(muscle);
  }

  protected isSecondary(muscle: MuscleId): boolean {
    return this.secondary().includes(muscle) && !this.isPrimary(muscle);
  }

  protected faceLabel(face: BodyFace): string {
    return face === 'front'
      ? $localize`:@@training.detail.muscles.front:Frente`
      : $localize`:@@training.detail.muscles.back:Costas`;
  }

  protected imageLabel(face: BodyFace): string {
    const highlighted = [...this.primary(), ...this.secondary()]
      .filter((muscle, index, all) => all.indexOf(muscle) === index)
      .filter((muscle) => BODY_ZONES[face].some((zone) => zone.muscle === muscle))
      .map((muscle) => muscleLabel(muscle))
      .join(', ');
    return highlighted
      ? $localize`:@@training.detail.muscles.image:${this.faceLabel(face)}:face:; músculos destacados: ${highlighted}:muscles:`
      : this.faceLabel(face);
  }
}
