import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { LocalCalendarEntry } from '../data/calendar/calendar-entry';
import { formatKg } from '../shell/format';
import { setsText } from './today-text';
import type { Workout } from './week-calendar-model';

/** O dia escolhido no calendário do mês: a data, a nota e a ausência dele e a lista dos treinos feitos. */
@Component({
  selector: 'app-calendar-day-detail',
  templateUrl: './calendar-day-detail.html',
  styleUrl: './calendar-day-detail.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CalendarDayDetail {
  /** A data por extenso, já formatada. */
  readonly heading = input.required<string>();
  /** Nota e ausência do dia, quando há. */
  readonly entry = input<LocalCalendarEntry | null>(null);
  readonly workouts = input.required<readonly Workout[]>();
  /** Tocaram num treino da lista: quem mostra o dia decide para onde levar. */
  readonly workoutOpened = output<Workout>();

  protected formatVolume(value: number): string {
    return formatKg(value);
  }

  protected formatSets(count: number): string {
    return setsText(count);
  }
}
