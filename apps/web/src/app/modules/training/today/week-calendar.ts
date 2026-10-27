import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { QUEUE_RUNTIME } from '../../../core/offline-queue/queue-ports';
import { GoalRepository } from '../data/goals/goal-repository';
import { RoutineRepository } from '../data/routines/routine-repository';
import { SessionRepository } from '../data/sessions/session-repository';
import { civilDateOf, dateKey, deviceTimeZone, monthRange } from '../domain/progress/calendar';
import { formatKg } from '../shell/format';
import { TrainingSheet } from '../shell/training-sheet';
import {
  type CalendarDay,
  type CalendarMonth,
  moveMonth,
  sundayMonth,
  sundayWeek,
} from './week-calendar-model';

interface Workout {
  readonly sessionId: string;
  readonly dayKey: string;
  readonly name: string;
  readonly sets: number;
  readonly volumeKg: number;
}

interface PeriodRead {
  readonly key: string;
  readonly workouts: readonly Workout[];
}

const weekdays = [
  $localize`:@@training.today.calendar.sun:dom`,
  $localize`:@@training.today.calendar.mon:seg`,
  $localize`:@@training.today.calendar.tue:ter`,
  $localize`:@@training.today.calendar.wed:qua`,
  $localize`:@@training.today.calendar.thu:qui`,
  $localize`:@@training.today.calendar.fri:sex`,
  $localize`:@@training.today.calendar.sat:sáb`,
];

const fullDate = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeZone: 'UTC' });
const monthName = new Intl.DateTimeFormat('pt-BR', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const dateAt = (day: CalendarDay) => new Date(Date.UTC(day.year, day.month - 1, day.day));
const sentenceCase = (value: string) => value.charAt(0).toLocaleUpperCase('pt-BR') + value.slice(1);
const setsText = (count: number) =>
  count === 1
    ? $localize`:@@training.today.calendar.one-set:1 série`
    : $localize`:@@training.today.calendar.many-sets:${count}:count: séries`;

/** Visão compacta de domingo a sábado e calendário completo, ambos lidos do banco da conta em uso. */
@Component({
  selector: 'app-week-calendar',
  imports: [TrainingSheet],
  templateUrl: './week-calendar.html',
  styleUrl: './week-calendar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WeekCalendar {
  private readonly sessions = inject(SessionRepository);
  private readonly routines = inject(RoutineRepository);
  private readonly goals = inject(GoalRepository);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly router = inject(Router);
  private readonly zone = deviceTimeZone();

  protected readonly weekdays = weekdays;
  protected readonly sheetOpen = signal(false);
  protected readonly weekOffset = signal(0);
  protected readonly month = signal<CalendarMonth>(this.currentMonth());
  protected readonly selectedKey = signal(dateKey(this.runtime.now(), this.zone));
  protected readonly weeklyGoal = signal<number | null>(null);
  private readonly weekRead = signal<PeriodRead | null>(null);
  private readonly monthRead = signal<PeriodRead | null>(null);
  private weekTicket = 0;
  private monthTicket = 0;

  protected readonly week = computed(() =>
    sundayWeek(this.runtime.now(), this.weekOffset(), this.zone),
  );
  protected readonly monthDays = computed(() => sundayMonth(this.month()));
  protected readonly weekWorkouts = computed(() => {
    const read = this.weekRead();
    return read?.key === this.week().days[0].key ? read.workouts : null;
  });
  protected readonly monthWorkouts = computed(() => {
    const read = this.monthRead();
    const month = this.month();
    return read?.key === `${month.year}-${month.month}` ? read.workouts : null;
  });
  protected readonly weekCount = computed(() => this.weekWorkouts()?.length ?? 0);
  protected readonly weekSets = computed(
    () => this.weekWorkouts()?.reduce((sum, workout) => sum + workout.sets, 0) ?? 0,
  );
  protected readonly weekVolume = computed(() =>
    formatKg(this.weekWorkouts()?.reduce((sum, workout) => sum + workout.volumeKg, 0) ?? 0),
  );
  protected readonly monthSets = computed(
    () => this.monthWorkouts()?.reduce((sum, workout) => sum + workout.sets, 0) ?? 0,
  );
  protected readonly monthSetsText = computed(() => setsText(this.monthSets()));
  protected readonly monthCountText = computed(() => {
    const count = this.monthWorkouts()?.length ?? 0;
    return count === 1
      ? $localize`:@@training.today.calendar.month-one:1 treino`
      : $localize`:@@training.today.calendar.month-many:${count}:count: treinos`;
  });
  protected readonly monthVolume = computed(() =>
    formatKg(this.monthWorkouts()?.reduce((sum, workout) => sum + workout.volumeKg, 0) ?? 0),
  );
  protected readonly selectedWorkouts = computed(
    () => this.monthWorkouts()?.filter((workout) => workout.dayKey === this.selectedKey()) ?? [],
  );
  protected readonly monthLabel = computed(() =>
    sentenceCase(
      monthName.format(new Date(Date.UTC(this.month().year, this.month().month - 1, 1))),
    ),
  );
  protected readonly selectedLabel = computed(() =>
    sentenceCase(fullDate.format(new Date(`${this.selectedKey()}T00:00:00Z`))),
  );
  protected readonly paid = computed(
    () =>
      this.weekOffset() === 0 &&
      this.hasWorkout(dateKey(this.runtime.now(), this.zone), this.weekWorkouts()),
  );
  protected readonly goalLine = computed(() => {
    const goal = this.weeklyGoal();
    const count = this.weekCount();
    return goal === null
      ? $localize`:@@training.today.calendar.goal-none:Sem meta semanal definida`
      : goal === 1
        ? $localize`:@@training.today.calendar.goal-count-one:${count}:count: de 1 treino na meta semanal`
        : $localize`:@@training.today.calendar.goal-count:${count}:count: de ${goal}:goal: treinos na meta semanal`;
  });
  protected readonly goalNote = computed(() => {
    const goal = this.weeklyGoal();
    return goal === null
      ? $localize`:@@training.today.calendar.goal-none:Sem meta semanal definida`
      : goal === 1
        ? $localize`:@@training.today.calendar.goal-note-one:Meta semanal: 1 treino`
        : $localize`:@@training.today.calendar.goal-note:Meta semanal: ${goal}:goal: treinos`;
  });
  protected readonly calendarHeading = $localize`:@@training.today.calendar.heading:Calendário de treinos`;

  constructor() {
    effect(() => {
      this.sessions.revision();
      const week = this.week();
      untracked(() => void this.loadWeek(week));
    });
    effect(() => {
      this.sessions.revision();
      const month = this.month();
      if (!this.sheetOpen()) return;
      untracked(() => void this.loadMonth(month));
    });
    effect(() => {
      this.goals.revision();
      untracked(() => void this.loadGoal());
    });
  }

  protected moveWeek(offset: number): void {
    this.weekOffset.update((current) => current + offset);
  }

  protected moveCalendarMonth(offset: number): void {
    const month = moveMonth(this.month(), offset);
    this.month.set(month);
    this.selectedKey.set(`${month.year}-${String(month.month).padStart(2, '0')}-01`);
  }

  protected openDay(day?: CalendarDay): void {
    if (day) {
      const workouts = this.weekWorkouts()?.filter((workout) => workout.dayKey === day.key) ?? [];
      if (workouts.length === 1) {
        this.openWorkout(workouts[0]);
        return;
      }
    }
    if (day) {
      this.month.set({ year: day.year, month: day.month });
      this.selectedKey.set(day.key);
    } else {
      const now = civilDateOf(this.runtime.now(), this.zone);
      this.month.set({ year: now.year, month: now.month });
      this.selectedKey.set(dateKey(this.runtime.now(), this.zone));
    }
    this.sheetOpen.set(true);
  }

  /** No mês aberto, um único treino no dia vai direto ao detalhe; vários ficam para a lista daquele dia. */
  protected openMonthDay(day: CalendarDay): void {
    const workouts = this.monthWorkouts()?.filter((workout) => workout.dayKey === day.key) ?? [];
    if (workouts.length === 1) {
      this.openWorkout(workouts[0]);
      return;
    }
    this.selectedKey.set(day.key);
  }

  protected hasWorkout(key: string, workouts: readonly Workout[] | null): boolean {
    return workouts?.some((workout) => workout.dayKey === key) ?? false;
  }

  protected isToday(key: string): boolean {
    return key === dateKey(this.runtime.now(), this.zone);
  }

  /** Dias depois de hoje ficam mais apagados; a chave é AAAA-MM-DD, então a ordem do texto é a do calendário. */
  protected isFuture(key: string): boolean {
    return key > dateKey(this.runtime.now(), this.zone);
  }

  protected dayLabel(day: CalendarDay, workouts: readonly Workout[] | null): string {
    const date = fullDate.format(dateAt(day));
    return this.hasWorkout(day.key, workouts)
      ? $localize`:@@training.today.calendar.day-done:${date}:date:, treino feito`
      : $localize`:@@training.today.calendar.day-empty:${date}:date:, sem treino`;
  }

  protected weekDayLabel(
    day: CalendarDay,
    index: number,
    workouts: readonly Workout[] | null,
  ): string {
    const visibleDate = `${this.weekdays[index]} ${day.day}`;
    const count = workouts?.filter((workout) => workout.dayKey === day.key).length ?? 0;
    return count === 0
      ? $localize`:@@training.today.calendar.week-day-empty:${visibleDate}:date:, sem treino`
      : count === 1
        ? $localize`:@@training.today.calendar.week-day-one:${visibleDate}:date:, 1 treino`
        : $localize`:@@training.today.calendar.week-day-many:${visibleDate}:date:, ${count}:count: treinos`;
  }

  protected formatVolume(value: number): string {
    return formatKg(value);
  }

  protected formatSets(count: number): string {
    return setsText(count);
  }

  /** O resumo reutiliza a página que já edita e apaga séries, sempre a partir do banco local. */
  protected openWorkout(workout: Workout): void {
    this.sheetOpen.set(false);
    void this.router.navigate(['/treino'], {
      queryParams: { resumo: workout.sessionId, historico: '1' },
    });
  }

  private currentMonth(): CalendarMonth {
    const now = civilDateOf(this.runtime.now(), this.zone);
    return { year: now.year, month: now.month };
  }

  private async loadGoal(): Promise<void> {
    try {
      this.weeklyGoal.set(await this.goals.value('weekly_sessions'));
    } catch {
      this.weeklyGoal.set(null);
    }
  }

  private async loadWeek(week: ReturnType<typeof sundayWeek>): Promise<void> {
    const ticket = ++this.weekTicket;
    try {
      const workouts = await this.readWorkouts(week.start, week.end);
      if (ticket === this.weekTicket) this.weekRead.set({ key: week.days[0].key, workouts });
    } catch {
      if (ticket === this.weekTicket) this.weekRead.set({ key: week.days[0].key, workouts: [] });
    }
  }

  private async loadMonth(month: CalendarMonth): Promise<void> {
    const ticket = ++this.monthTicket;
    const range = monthRange(month.year, month.month, this.zone);
    try {
      const workouts = await this.readWorkouts(range.start, range.end);
      if (ticket === this.monthTicket)
        this.monthRead.set({ key: `${month.year}-${month.month}`, workouts });
    } catch {
      if (ticket === this.monthTicket)
        this.monthRead.set({ key: `${month.year}-${month.month}`, workouts: [] });
    }
  }

  private async readWorkouts(from: number, to: number): Promise<Workout[]> {
    const sessions = await this.sessions.sessionsBetween(from, to - 1);
    const rows = await Promise.all(
      sessions.map(async (session) => {
        const [sets, routine] = await Promise.all([
          this.sessions.setsOfSession(session.id),
          session.routineId === null
            ? Promise.resolve(undefined)
            : this.routines.get(session.routineId),
        ]);
        const working = sets.filter((set) => set.setType !== 'warmup');
        if (working.length === 0) return null;
        return {
          sessionId: session.id,
          dayKey: dateKey(session.startedAt, this.zone),
          name: routine?.name ?? $localize`:@@training.today.calendar.free:Treino livre`,
          sets: working.length,
          volumeKg: working.reduce((sum, set) => sum + (set.weightKg ?? 0) * (set.reps ?? 0), 0),
        };
      }),
    );
    return rows.filter((row): row is Workout => row !== null);
  }
}
