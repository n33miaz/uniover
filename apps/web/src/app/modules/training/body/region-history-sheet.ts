import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { LocalBodyEntry } from '../data/body/body-entry';
import type { BodyMapRegion } from '../domain/body/body-map-signals';
import { regionHistory, type RegionHistoryCell } from '../domain/body/body-region-history';
import { TrainingSheet } from '../shell/training-sheet';
import { formatCm, formatFullDate } from './body-text';

/**
 * A folha de histórico de uma região do mapa: a evolução daquela medida, da mais nova para a mais antiga, com direito e
 * esquerda lado a lado e a variação contra a medição anterior. Só leitura; o rodapé leva ao registro de novas medidas.
 */
@Component({
  selector: 'app-body-region-history-sheet',
  imports: [TrainingSheet],
  template: `
    <app-training-sheet [heading]="heading()" (closed)="closed.emit()">
      @if (rows().length === 0) {
        <p class="empty" i18n="@@training.body.history.empty">Ainda não há medidas desta região.</p>
      } @else {
        <ol
          class="rows"
          i18n-aria-label="@@training.body.history.list"
          aria-label="Medições da região"
        >
          @for (row of rows(); track row.id) {
            <li class="row">
              <span class="date">{{ date(row.measuredOn) }}</span>
              <span class="cells">
                @for (cell of row.cells; track cell.field) {
                  <span class="cell">
                    @if (sideTag(cell); as tag) {
                      <span class="tag" aria-hidden="true">{{ tag }}</span
                      ><span class="ui-visually-hidden">{{ sideName(cell) }}</span>
                    }
                    <strong>{{ cm(cell.valueCm) }}</strong>
                    @if (cell.deltaCm !== null && cell.deltaCm !== 0) {
                      <small [class.up]="cell.deltaCm > 0" [class.down]="cell.deltaCm < 0">{{
                        delta(cell.deltaCm)
                      }}</small>
                    }
                  </span>
                }
              </span>
            </li>
          }
        </ol>
      }
      <button sheetAction type="button" class="primary ui-btn" (click)="register.emit()">
        <span i18n="@@training.body.history.register">Registrar Medidas</span>
      </button>
    </app-training-sheet>
  `,
  styleUrl: './region-history-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodyRegionHistorySheet {
  readonly region = input.required<BodyMapRegion>();
  /** As medições locais, da mais antiga à mais nova. */
  readonly entries = input.required<readonly LocalBodyEntry[]>();
  readonly closed = output<void>();
  /** O dono quer registrar uma medida nova a partir do histórico. */
  readonly register = output<void>();

  protected readonly rows = computed(() => regionHistory(this.entries(), this.region()));
  protected readonly heading = computed(() => {
    const name = this.regionName(this.region());
    return $localize`:@@training.body.history.heading:Histórico de ${name}:region:`;
  });
  protected readonly date = formatFullDate;
  protected readonly cm = formatCm;

  protected delta(value: number): string {
    const text = formatCm(Math.abs(value));
    return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text;
  }

  protected sideTag(cell: RegionHistoryCell): string {
    return cell.side === 'right' ? 'D' : cell.side === 'left' ? 'E' : '';
  }

  protected sideName(cell: RegionHistoryCell): string {
    return cell.side === 'right'
      ? $localize`:@@training.body.history.right:Direito`
      : $localize`:@@training.body.history.left:Esquerdo`;
  }

  private regionName(region: BodyMapRegion): string {
    return {
      chest: $localize`:@@training.body.history.region.chest:Tórax`,
      abdomen: $localize`:@@training.body.history.region.abdomen:Abdômen`,
      arm: $localize`:@@training.body.history.region.arm:Braços`,
      forearm: $localize`:@@training.body.history.region.forearm:Antebraços`,
      thigh: $localize`:@@training.body.history.region.thigh:Coxas`,
      calf: $localize`:@@training.body.history.region.calf:Panturrilhas`,
    }[region];
  }
}
