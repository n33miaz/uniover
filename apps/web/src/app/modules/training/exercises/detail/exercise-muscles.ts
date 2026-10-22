import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { MuscleId } from '../../domain/taxonomy';
import { muscleLabel } from '../../domain/taxonomy';
import {
  BODY_HEIGHT,
  BODY_FACES,
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

  protected readonly faces = computed(() => {
    const muscles = new Set([...this.primary(), ...this.secondary()]);
    return BODY_FACES.filter((face) => BODY_ZONES[face].some((zone) => muscles.has(zone.muscle)));
  });
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
    const names = (muscles: readonly MuscleId[]) =>
      [...new Set(muscles)]
        .filter((muscle) => BODY_ZONES[face].some((zone) => zone.muscle === muscle))
        .map((muscle) => muscleLabel(muscle))
        .join(', ');
    const primary = names(this.primary());
    const secondary = names(this.secondary().filter((muscle) => !this.isPrimary(muscle)));
    const parts: string[] = [];
    if (primary)
      parts.push(
        $localize`:@@training.detail.muscles.image-primary:principais: ${primary}:muscles:`,
      );
    if (secondary)
      parts.push(
        $localize`:@@training.detail.muscles.image-secondary:secundários: ${secondary}:muscles:`,
      );
    return parts.length > 0
      ? $localize`:@@training.detail.muscles.image-groups:${this.faceLabel(face)}:face:; ${parts.join('; ')}:muscles:`
      : this.faceLabel(face);
  }
}
