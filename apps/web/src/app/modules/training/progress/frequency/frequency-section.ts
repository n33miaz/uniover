import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { GoalRepository } from '../../data/goals/goal-repository';
import { type MonthCalendar, ProgressRepository } from '../../data/progress/progress-repository';
import { SessionRepository } from '../../data/sessions/session-repository';
import { civilDateOf, deviceTimeZone } from '../../domain/progress/calendar';
import { weeklyConstancy } from '../../domain/progress/week-stats';
import { type YearMonth, monthGrid, shiftMonth } from '../calendar-nav';
import { ProgressHistory } from '../history';
import { ProgressGlyph } from '../progress-glyph';
import { ProgressSection } from '../progress-section';
import { monthLabel, monthOnly } from '../progress-text';

const weekdayShort = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' });
const weekdayLong = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'UTC' });

/** Os sete dias da semana na ordem do calendário (domingo a sábado), curtos para o cabeçalho e por extenso para o leitor. */
export const WEEKDAYS: readonly { readonly short: string; readonly long: string }[] = Array.from(
  { length: 7 },
  (_, index) => {
    // 31 de dezembro de 2023 foi um domingo.
    const day = Date.UTC(2023, 11, 31 + index);
    return {
      short: weekdayShort.format(day).replace('.', ''),
      long: weekdayLong.format(day),
    };
  },
);

const treinosText = (count: number) =>
  count === 1
    ? $localize`:@@training.progress.frequency.workouts-one:1 treino`
    : $localize`:@@training.progress.frequency.workouts-many:${count}:count: treinos`;

/** "8 treinos" ou, sem nenhum, "nenhum treino" (para a linha do mês). */
export function monthWorkouts(count: number): string {
  return count === 0
    ? $localize`:@@training.progress.frequency.month-none:nenhum treino`
    : treinosText(count);
}

/**
 * A constância em uma frase, a partir dos treinos das duas últimas semanas completas: "3 treinos por semana nas duas
 * últimas semanas" quando foram iguais, "entre 2 e 3 treinos por semana..." quando não. Com meta (do dono), acrescenta a
 * meta e, havendo, quantas semanas seguidas ela foi cumprida. Sem meta, diz que ela é do dono. O app só conta.
 */
export function constancyLine(
  counts: readonly [number, number],
  goal: number | null,
  streak: number,
): string {
  const [first, second] = counts;
  let text: string;
  if (first === 0 && second === 0) {
    text = $localize`:@@training.progress.frequency.constancy-none:nenhum treino nas duas últimas semanas`;
  } else if (first === second) {
    text =
      first === 1
        ? $localize`:@@training.progress.frequency.constancy-one:1 treino por semana nas duas últimas semanas`
        : $localize`:@@training.progress.frequency.constancy-same:${first}:count: treinos por semana nas duas últimas semanas`;
  } else {
    const low = Math.min(first, second);
    const high = Math.max(first, second);
    text = $localize`:@@training.progress.frequency.constancy-range:entre ${low}:low: e ${high}:high: treinos por semana nas duas últimas semanas`;
  }
  const constancy = $localize`:@@training.progress.frequency.constancy:Constância: ${text}:text:`;
  if (goal === null) return constancy;
  const withGoal = $localize`:@@training.progress.frequency.constancy-goal:${constancy}:constancy: (meta: ${goal}:goal:)`;
  if (streak === 0) return withGoal;
  return streak === 1
    ? $localize`:@@training.progress.frequency.streak-one:${withGoal}:text:. 1 semana seguida com a meta`
    : $localize`:@@training.progress.frequency.streak-many:${withGoal}:text:. ${streak}:count: semanas seguidas com a meta`;
}

interface Read {
  readonly month: YearMonth;
  readonly calendar: MonthCalendar;
}

/**
 * A frequência: o calendário do mês (domingo a sábado) com os dias de treino preenchidos (forma e cor, não só cor) e o
 * dia de hoje com contorno, a navegação de mês a mês e a constância das duas últimas semanas.
 */
@Component({
  selector: 'app-progress-frequency',
  imports: [ProgressSection, ProgressGlyph],
  templateUrl: './frequency-section.html',
  styleUrl: './frequency-section.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgressFrequency {
  private readonly progress = inject(ProgressRepository);
  private readonly goals = inject(GoalRepository);
  private readonly sessions = inject(SessionRepository);
  private readonly history = inject(ProgressHistory);
  private readonly runtime = inject(QUEUE_RUNTIME);

  protected readonly heading = $localize`:@@training.progress.frequency.title:Frequência`;
  protected readonly open = signal(false);
  protected readonly weekdays = WEEKDAYS;
  protected readonly previousLabel = $localize`:@@training.progress.frequency.previous:Mês anterior`;
  protected readonly nextLabel = $localize`:@@training.progress.frequency.next:Próximo mês`;
  protected readonly noGoal = $localize`:@@training.progress.frequency.no-goal:Sem meta semanal definida.`;

  /** O mês que se vê; `null` até saber que mês é hoje. */
  private readonly viewing = signal<YearMonth | null>(null);
  private readonly today = signal<YearMonth>(this.currentMonth());
  private readonly read = signal<Read | null>(null);
  protected readonly goal = signal<number | null>(null);
  private ticket = 0;

  protected readonly month = computed(() => this.viewing() ?? this.today());
  protected readonly isCurrent = computed(() => {
    const month = this.month();
    const now = this.today();
    return month.year === now.year && month.month === now.month;
  });

  protected readonly viewed = computed(() => {
    const read = this.read();
    const month = this.month();
    return read !== null && read.month.year === month.year && read.month.month === month.month
      ? read.calendar
      : null;
  });

  protected readonly label = computed(() => monthLabel(this.month().year, this.month().month));

  protected readonly trainedCount = computed(() => this.viewed()?.days.length ?? 0);

  /** A linha fechada: sempre o mês de hoje. */
  protected readonly summary = computed(() => {
    const read = this.read();
    const now = this.today();
    if (read === null || read.month.year !== now.year || read.month.month !== now.month) return '';
    const name = monthOnly(now.year, now.month);
    const workouts = monthWorkouts(read.calendar.days.length);
    return $localize`:@@training.progress.frequency.summary:${name}:month: · ${workouts}:workouts:`;
  });

  protected readonly monthLine = computed(() => {
    const viewed = this.viewed();
    if (viewed === null) return '';
    const count = viewed.days.length;
    return count === 1
      ? $localize`:@@training.progress.frequency.in-month-one:1 treino no mês`
      : count === 0
        ? $localize`:@@training.progress.frequency.in-month-none:Nenhum treino no mês`
        : $localize`:@@training.progress.frequency.in-month:${count}:count: treinos no mês`;
  });

  protected readonly caption = computed(() => {
    const label = this.label();
    return $localize`:@@training.progress.frequency.caption:${label}:month:: dias com treino marcados`;
  });

  /** As semanas do mês, com o que cada dia precisa para ser desenhado. */
  protected readonly weeks = computed(() => {
    const viewed = this.viewed();
    const { year, month } = this.month();
    const grid = monthGrid(year, month, viewed?.daysInMonth ?? new Date(year, month, 0).getDate());
    const trained = new Set(viewed?.days ?? []);
    return grid.map((week) =>
      week.map((day) =>
        day === null
          ? null
          : {
              day,
              trained: trained.has(day),
              today: viewed?.today === day,
              label: trained.has(day) ? this.trainedLabel(day) : null,
            },
      ),
    );
  });

  protected readonly constancy = computed(() => {
    const data = this.history.data();
    if (data === null || !this.isCurrent()) return '';
    const goal = this.goal();
    const result = weeklyConstancy(
      data.sessions,
      goal ?? 1,
      deviceTimeZone(),
      this.runtime.now(),
      3,
    );
    const [first, second] = result.weeks;
    return constancyLine(
      [first.sessions, second.sessions],
      goal,
      goal === null ? 0 : result.consecutiveMetWeeks,
    );
  });

  constructor() {
    effect(() => {
      const month = this.month();
      this.sessions.revision();
      untracked(() => void this.load(month));
    });
    effect(() => {
      this.goals.revision();
      untracked(() => void this.loadGoal());
    });
    // Fechada, a seção volta para o mês de hoje: a linha fechada sempre fala do mês atual.
    effect(() => {
      if (!this.open()) untracked(() => this.viewing.set(null));
    });
  }

  protected move(delta: -1 | 1): void {
    this.viewing.set(shiftMonth(this.month(), delta));
  }

  /** "treino em 18/10", o que o leitor de tela diz do dia no lugar do número. */
  protected trainedLabel(day: number): string {
    const { month } = this.month();
    const text = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}`;
    return $localize`:@@training.progress.frequency.trained:treino em ${text}:date:`;
  }

  private currentMonth(): YearMonth {
    const date = civilDateOf(this.runtime.now(), deviceTimeZone());
    return { year: date.year, month: date.month };
  }

  private async load(month: YearMonth): Promise<void> {
    const ticket = ++this.ticket;
    const calendar = await this.progress.monthCalendar(month, {
      now: this.runtime.now(),
      timeZone: deviceTimeZone(),
    });
    if (ticket !== this.ticket) return;
    this.read.set({ month, calendar });
    this.today.set(this.currentMonth());
  }

  private async loadGoal(): Promise<void> {
    this.goal.set(await this.goals.value('weekly_sessions'));
  }
}
