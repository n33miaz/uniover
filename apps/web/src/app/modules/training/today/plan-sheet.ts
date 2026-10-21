import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
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
  imports: [TrainingSheet, TrainingGlyph, TodayGlyph],
  template: `
    <app-training-sheet [heading]="heading" (closed)="closed.emit()">
      <button sheetAction type="button" class="secondary ui-btn" (click)="add.emit()">
        <app-training-glyph name="plus" />
        <span i18n="@@training.plan.add">Adicionar exercício</span>
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
                <span class="ui-chip accent" i18n="@@training.plan.now">agora</span>
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

  readonly chosen = output<string>();
  readonly add = output<void>();
  readonly closed = output<void>();

  protected readonly heading = $localize`:@@training.plan.title:Exercícios do treino`;
  protected readonly fallbackName = $localize`:@@training.plan.unknown:Exercício removido`;

  protected isComplete(entry: LiveEntry): boolean {
    return entry.targetSets !== null && entry.doneSets >= entry.targetSets;
  }

  protected detail(entry: LiveEntry): string {
    const done = entry.doneSets;
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
