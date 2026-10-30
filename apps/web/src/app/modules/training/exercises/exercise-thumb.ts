import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { illustrationFor, illustrationUrl } from '../illustrations/illustration-map';
import { TrainingGlyph } from '../shell/training-glyph';

/**
 * A miniatura de 64 px de um exercício nas listas (biblioteca, seletores e a rotina de Hoje): somente a primeira pose de
 * uma ilustração confirmada, sem animação no espaço curto da lista. Sem arte segura para o `slug`, a moldura mostra o
 * glifo neutro e não sugere outro movimento. É decorativa: o nome do exercício está na linha, ao lado.
 */
@Component({
  selector: 'app-exercise-thumb',
  imports: [TrainingGlyph],
  host: { class: 'thumb', 'aria-hidden': 'true' },
  template: `
    @if (imageUrl(); as source) {
      <img [src]="source" [alt]="''" width="64" height="64" />
    } @else {
      <span class="placeholder">
        <app-training-glyph name="dumbbell" />
      </span>
    }
  `,
  styleUrl: './exercise-thumb.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExerciseThumb {
  /** `slug` do exercício no catálogo; `null` quando o exercício já não está nele. */
  readonly slug = input.required<string | null>();

  protected readonly imageUrl = computed(() => {
    const slug = this.slug();
    const entry = slug === null ? undefined : illustrationFor(slug);
    return entry === undefined ? null : illustrationUrl(entry.frames[0]);
  });
}
