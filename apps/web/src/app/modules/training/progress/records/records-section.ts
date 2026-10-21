import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { ProgressRepository } from '../../data/progress/progress-repository';
import { SessionRepository } from '../../data/sessions/session-repository';
import { dateKey, deviceTimeZone } from '../../domain/progress/calendar';
import type { PersonalRecords } from '../../domain/progress/records';
import { formatDayMonth, formatKg } from '../../shell/format';
import { formatOneRepMax } from '../progress-text';
import { ProgressSection } from '../progress-section';

export interface RecordRow {
  readonly key: 'maxWeight' | 'oneRepMax' | 'sessionVolume' | 'repsAtLoad';
  readonly title: string;
  readonly value: string;
  /** A data do recorde e o que o explica ("18/10 · 42,5 kg × 8"). */
  readonly detail: string;
  /** Foi batido no último treino do exercício: ganha o selo "recorde". */
  readonly recent: boolean;
}

/**
 * As linhas da lista de recordes de um exercício, só as que existem. A carga do recorde de repetições vai por extenso no
 * título ("Mais repetições com 40 kg"), para não parecer arbitrária. O selo "recorde" marca o que foi batido no último
 * dia em que o exercício foi treinado (`lastDay`, `AAAA-MM-DD`).
 */
export function recordRows(
  records: PersonalRecords,
  lastDay: string | null,
  timeZone: string = deviceTimeZone(),
): RecordRow[] {
  const rows: RecordRow[] = [];
  const recent = (at: number) => lastDay !== null && dateKey(at, timeZone) === lastDay;

  const max = records.maxWeight;
  if (max) {
    rows.push({
      key: 'maxWeight',
      title: $localize`:@@training.progress.records.max-weight:Carga máxima`,
      value: `${formatKg(max.weightKg)} × ${max.reps}`,
      detail: formatDayMonth(max.completedAt),
      recent: recent(max.completedAt),
    });
  }
  const rm = records.oneRepMax;
  if (rm) {
    const day = formatDayMonth(rm.completedAt);
    const load = `${formatKg(rm.weightKg)} × ${rm.reps}`;
    rows.push({
      key: 'oneRepMax',
      title: $localize`:@@training.progress.records.one-rep-max:1RM estimado`,
      value: formatOneRepMax(rm.valueKg),
      detail: $localize`:@@training.progress.records.one-rep-max-detail:${day}:day: · de ${load}:load:`,
      recent: recent(rm.completedAt),
    });
  }
  const volume = records.maxSessionVolume;
  if (volume) {
    const day = formatDayMonth(volume.completedAt);
    const sets = volume.sets;
    rows.push({
      key: 'sessionVolume',
      title: $localize`:@@training.progress.records.volume:Maior volume em um treino`,
      value: formatKg(volume.volumeKg),
      detail:
        sets === 1
          ? $localize`:@@training.progress.records.volume-detail-one:${day}:day: · 1 série`
          : $localize`:@@training.progress.records.volume-detail:${day}:day: · ${sets}:sets: séries`,
      recent: recent(volume.completedAt),
    });
  }
  const reps = records.maxRepsAtLoad;
  if (reps) {
    const load = formatKg(reps.weightKg);
    rows.push({
      key: 'repsAtLoad',
      title: $localize`:@@training.progress.records.reps:Mais repetições com ${load}:load:`,
      value: String(reps.reps),
      detail: formatDayMonth(reps.completedAt),
      recent: recent(reps.completedAt),
    });
  }
  return rows;
}

/**
 * Recordes do exercício do gráfico: carga máxima, 1RM estimado, maior volume em um treino e mais repetições na carga de
 * referência. Fechada, a linha já diz o essencial ("Carga máx. 42,5 kg · 1RM 53,8 kg").
 */
@Component({
  selector: 'app-progress-records',
  imports: [ProgressSection],
  template: `
    <app-progress-section
      [heading]="heading"
      [summary]="summary()"
      [glyph]="'star'"
      [(open)]="open"
    >
      @if (rows().length > 0) {
        <ul class="list ui-plain">
          @for (row of rows(); track row.key) {
            <li class="row">
              <span class="text">
                <span class="title">{{ row.title }}</span>
                <span class="detail">{{ row.detail }}</span>
              </span>
              @if (row.recent) {
                <span class="ui-chip ok" i18n="@@training.progress.records.badge">recorde</span>
              }
              <b class="value">{{ row.value }}</b>
            </li>
          }
        </ul>
        <p class="note" i18n="@@training.progress.records.reference">
          O recorde de repetições vale para a carga que você mais usou nos últimos quatro treinos.
        </p>
      } @else {
        <p class="note" i18n="@@training.progress.records.none">
          Sem recordes ainda: eles aparecem depois do primeiro treino com carga neste exercício.
        </p>
      }
    </app-progress-section>
  `,
  styleUrl: './records-section.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgressRecords {
  private readonly progress = inject(ProgressRepository);
  private readonly sessions = inject(SessionRepository);

  readonly exerciseId = input.required<string>();

  protected readonly heading = $localize`:@@training.progress.records.title:Recordes`;
  protected readonly open = signal(false);
  private readonly read = signal<{
    readonly id: string;
    readonly records: PersonalRecords;
    readonly lastDay: string | null;
  } | null>(null);
  private ticket = 0;

  protected readonly rows = computed(() => {
    const read = this.read();
    if (read === null || read.id !== this.exerciseId()) return [];
    return recordRows(read.records, read.lastDay);
  });

  protected readonly summary = computed(() => {
    const read = this.read();
    if (read === null || read.id !== this.exerciseId()) return '';
    const rows = this.rows();
    const max = rows.find((row) => row.key === 'maxWeight');
    const rm = rows.find((row) => row.key === 'oneRepMax');
    if (!max) return $localize`:@@training.progress.records.summary-none:Sem registro ainda`;
    const maxText = max.value.split(' × ')[0];
    return rm
      ? $localize`:@@training.progress.records.summary:Carga máx. ${maxText}:max: · 1RM ${rm.value}:rm:`
      : $localize`:@@training.progress.records.summary-max:Carga máx. ${maxText}:max:`;
  });

  constructor() {
    effect(() => {
      const id = this.exerciseId();
      this.sessions.revision();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string): Promise<void> {
    const ticket = ++this.ticket;
    const [records, series] = await Promise.all([
      this.progress.records(id),
      this.progress.exerciseSeries(id, 'all'),
    ]);
    if (ticket !== this.ticket) return;
    this.read.set({ id, records, lastDay: series.points.at(-1)?.date ?? null });
  }
}
