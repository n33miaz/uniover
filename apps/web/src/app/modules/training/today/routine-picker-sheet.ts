import { ChangeDetectionStrategy, Component, input, output, viewChild } from '@angular/core';
import type { RoutineEntry } from '../routines/routine-stats';
import { TrainingSheet } from '../shell/training-sheet';
import { routineSummary } from './today-text';

/**
 * Folha "Escolher outra rotina": as rotinas ativas na ordem da sequência, com qual é a próxima. Um toque escolhe e fecha;
 * a escolha vale só para o treino de hoje (a sequência não muda até o treino terminar).
 */
@Component({
  selector: 'app-routine-picker-sheet',
  imports: [TrainingSheet],
  template: `
    <app-training-sheet [heading]="heading" [dismissLabel]="cancelLabel" (closed)="closed.emit()">
      <ul class="list ui-group ui-plain">
        @for (entry of entries(); track entry.routine.id) {
          <li>
            <button
              type="button"
              class="ui-row"
              [attr.aria-pressed]="entry.routine.id === selectedId()"
              (click)="pick(entry)"
            >
              <span class="ui-tile">{{ entry.letter }}</span>
              <span class="ui-row-text">
                @if (entry.next) {
                  <span class="eyebrow" i18n="@@training.today.picker-next">próxima</span>
                }
                <span class="ui-row-title">{{ entry.routine.name }}</span>
                <span class="ui-row-sub">{{ summary(entry) }}</span>
              </span>
              @if (entry.routine.id === selectedId()) {
                <span class="ui-chip accent" i18n="@@training.today.picker-selected"
                  >no cartão</span
                >
              }
            </button>
          </li>
        }
      </ul>
    </app-training-sheet>
  `,
  styles: `
    .list {
      margin: 0;
    }
    /* A folha abre com o foco na primeira linha: o anel fica por dentro dela (por fora, o grupo o cortaria numa linha solta). */
    .ui-row:focus-visible {
      outline-offset: -3px;
    }
    .eyebrow {
      color: var(--a-accent-ink);
      font-size: var(--fs-label);
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoutinePickerSheet {
  private readonly sheet = viewChild.required(TrainingSheet);

  readonly entries = input.required<readonly RoutineEntry[]>();
  readonly selectedId = input<string | null>(null);

  readonly picked = output<string>();
  readonly closed = output<void>();

  protected readonly heading = $localize`:@@training.today.picker-title:Escolher outra rotina`;
  protected readonly cancelLabel = $localize`:@@training.today.picker-cancel:Cancelar`;

  protected summary(entry: RoutineEntry): string {
    return routineSummary(entry);
  }

  protected pick(entry: RoutineEntry): void {
    this.picked.emit(entry.routine.id);
    this.sheet().close();
  }
}
