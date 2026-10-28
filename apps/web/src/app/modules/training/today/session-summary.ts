import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { OfflineQueue } from '../../../core/offline-queue/offline-queue';
import { CalendarEntryRepository } from '../data/calendar/calendar-entry-repository';
import type { LocalSet } from '../data/sessions/session';
import { dateKey, deviceTimeZone } from '../domain/progress/calendar';
import type { SetType } from '../domain/session/session-model';
import { SessionRepository } from '../data/sessions/session-repository';
import { formatKg } from '../shell/format';
import { TrainingGlyph } from '../shell/training-glyph';
import { type RecordLine, LiveStore, type SummaryData } from './live-store';
import { SetEditSheet } from './set-edit-sheet';
import { TodayGlyph } from './today-glyph';
import { TodayStore } from './today-store';
import { setText } from './today-text';

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * O resumo ao terminar o treino: os quatro números (volume, duração, séries, recordes), os recordes com o valor de antes e
 * o recado de que tudo está salvo no aparelho (e quantas séries ainda esperam envio). "Concluir treino" volta a Hoje;
 * "Editar treino" abre a lista das séries, para corrigir ou apagar uma. Tudo vem do banco local pelo id do treino, então
 * recarregar nesta tela mostra o mesmo resumo.
 */
@Component({
  selector: 'app-session-summary',
  imports: [TrainingGlyph, TodayGlyph, SetEditSheet],
  templateUrl: './session-summary.html',
  styleUrl: './session-summary.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionSummary {
  private readonly live = inject(LiveStore);
  private readonly today = inject(TodayStore);
  private readonly sessions = inject(SessionRepository);
  private readonly calendarEntries = inject(CalendarEntryRepository);
  private readonly zone = deviceTimeZone();
  private readonly queue = inject(OfflineQueue);
  private readonly injector = inject(Injector);

  readonly sessionId = input.required<string>();
  /** O histórico do calendário já abre com a lista de séries; o resumo recém-concluído segue compacto. */
  readonly showSets = input(false);
  /** "Concluir treino": volta a Hoje. */
  readonly done = output<void>();

  private readonly title = viewChild<ElementRef<HTMLElement>>('title');

  /** `undefined` enquanto lê; `null` quando o treino não existe ou ainda está aberto. */
  protected readonly data = signal<SummaryData | null | undefined>(undefined);
  protected readonly editing = signal(false);
  protected readonly editSet = signal<LocalSet | null>(null);
  /** A nota que a pessoa deixou no dia em que o treino começou; vazia quando não há. */
  protected readonly dayNote = signal('');

  protected readonly minutes = computed(() => {
    const ms = this.data()?.summary.durationMs ?? null;
    return ms === null ? null : Math.max(0, Math.round(ms / 60_000));
  });
  protected readonly volume = computed(() => formatKg(this.data()?.summary.volumeKg ?? 0));

  /** Recado de envio: quantas séries ainda esperam, ou que está tudo sincronizado. */
  protected readonly sendText = computed(() => {
    const waiting = this.today.awaitingSetsOf(this.sessionId());
    if (waiting === 1) return $localize`:@@training.summary.awaiting-one:1 série aguarda envio`;
    if (waiting > 1) {
      return $localize`:@@training.summary.awaiting-many:${waiting}:count: séries aguardam envio`;
    }
    return this.queue.pendingCount() > 0
      ? $localize`:@@training.summary.awaiting-treino:o treino aguarda envio`
      : $localize`:@@training.summary.synced:tudo sincronizado`;
  });

  constructor() {
    effect(() => {
      this.sessions.revision();
      this.calendarEntries.revision();
      const id = this.sessionId();
      untracked(() => void this.load(id));
    });
    // O foco vai para o título assim que o resumo aparece: quem usa leitor de tela ouve que o treino acabou.
    let focused = false;
    effect(() => {
      if (this.data() === undefined || focused) return;
      focused = true;
      afterNextRender(() => this.title()?.nativeElement.focus({ preventScroll: true }), {
        injector: this.injector,
      });
    });
  }

  protected recordTitle(record: RecordLine): string {
    return record.exerciseName === '' ? this.fallbackName : record.exerciseName;
  }

  protected recordDetail(record: RecordLine): string {
    const before = formatKg(round1(record.previousKg));
    if (record.kind === 'maxWeight') {
      const value = formatKg(record.valueKg);
      const reps = record.reps;
      return $localize`:@@training.summary.record-max:carga máxima ${value}:value: × ${reps}:reps: · antes ${before}:before:`;
    }
    const value = formatKg(round1(record.valueKg));
    return $localize`:@@training.summary.record-1rm:1RM estimado ${value}:value: · antes ${before}:before:`;
  }

  protected rowText(set: LocalSet): string {
    const exercise = this.data()?.exercises.get(set.exerciseId);
    return exercise ? setText(set, exercise.recordType) : '';
  }

  protected rowName(set: LocalSet): string {
    return this.data()?.exercises.get(set.exerciseId)?.name ?? this.fallbackName;
  }

  protected setTypeText(type: SetType): string {
    switch (type) {
      case 'warmup':
        return $localize`:@@training.summary.set-type-warmup:Aquecimento`;
      case 'failure':
        return $localize`:@@training.summary.set-type-failure:Falha`;
      case 'drop':
        return $localize`:@@training.summary.set-type-drop:Drop set`;
      default:
        return $localize`:@@training.summary.set-type-work:Trabalho`;
    }
  }

  protected readonly backLabel = $localize`:@@training.summary.back:Voltar a Hoje`;
  protected readonly freeName = $localize`:@@training.summary.free:Treino Livre`;
  protected readonly fallbackName = $localize`:@@training.summary.unknown:Exercício removido`;

  private async load(id: string): Promise<void> {
    try {
      const data = await this.live.loadSummary(id);
      this.data.set(data);
      const entry = data
        ? await this.calendarEntries.get(dateKey(data.session.startedAt, this.zone))
        : undefined;
      this.dayNote.set(entry?.note ?? '');
    } catch {
      // Sem banco local não há resumo para mostrar: cai no estado de "treino não encontrado".
      this.data.set(null);
    }
  }
}
