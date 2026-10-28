import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { QUEUE_RUNTIME } from '../../../core/offline-queue/queue-ports';
import { GoalRepository } from '../data/goals/goal-repository';
import { CalendarEntryRepository } from '../data/calendar/calendar-entry-repository';
import type { LocalCalendarEntry } from '../data/calendar/calendar-entry';
import type { LocalRoutine } from '../data/routines/routine';
import { RoutineRepository } from '../data/routines/routine-repository';
import { SessionRepository } from '../data/sessions/session-repository';
import { civilDateOf, dateKey, deviceTimeZone, monthRange } from '../domain/progress/calendar';
import {
  type TrainingDayState,
  type WeekRhythm,
  programWeeklyGoal,
  remainingWorkouts,
  weeklyStreak,
} from '../domain/progress/training-rhythm';
import { routinesOnWeekday } from '../domain/routines/week-plan';
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
/** Quantas semanas para trás a sequência olha; mais que isso só pesa a leitura e a meta de meses atrás já mudou. */
const STREAK_WEEKS = 12;

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
  private readonly calendarEntries = inject(CalendarEntryRepository);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly router = inject(Router);
  private readonly zone = deviceTimeZone();

  protected readonly weekdays = weekdays;
  protected readonly sheetOpen = signal(false);
  protected readonly weekOffset = signal(0);
  protected readonly month = signal<CalendarMonth>(this.currentMonth());
  protected readonly selectedKey = signal(dateKey(this.runtime.now(), this.zone));
  protected readonly weeklyGoal = signal<number | null>(null);
  /** Tocar num dia planejado escolhe a ficha dele para o treino de hoje. */
  readonly routineChosen = output<string>();
  private readonly programGoal = signal<number | null>(null);
  protected readonly effectiveGoal = computed(() => this.weeklyGoal() ?? this.programGoal());
  private readonly weekRead = signal<PeriodRead | null>(null);
  private readonly monthRead = signal<PeriodRead | null>(null);
  private readonly weekEntries = signal<readonly LocalCalendarEntry[]>([]);
  private readonly monthEntries = signal<readonly LocalCalendarEntry[]>([]);
  private readonly planRoutines = signal<readonly LocalRoutine[]>([]);
  private readonly planProgramId = signal<string | null>(null);
  protected readonly streak = signal(0);
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
  protected readonly remaining = computed(() => {
    const goal = this.effectiveGoal();
    if (goal === null) return null;
    const { absentDays, availableDays } = this.absenceOf(this.week().days, this.weekEntries());
    return remainingWorkouts(goal, this.weekCount(), absentDays, availableDays);
  });
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
  protected readonly selectedEntry = computed(
    () => this.monthEntries().find((entry) => entry.dayKey === this.selectedKey()) ?? null,
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
    const goal = this.effectiveGoal();
    const count = this.weekCount();
    return goal === null
      ? $localize`:@@training.today.calendar.goal-none:Sem meta semanal definida`
      : goal === 1
        ? $localize`:@@training.today.calendar.goal-count-one:${count}:count: de 1 treino`
        : $localize`:@@training.today.calendar.goal-count:${count}:count: de ${goal}:goal: treinos`;
  });
  protected readonly streakLine = computed(() => {
    const weeks = this.streak();
    return weeks === 0
      ? $localize`:@@training.today.calendar.streak-none:Sem sequência de semanas`
      : weeks === 1
        ? $localize`:@@training.today.calendar.streak-one:Sequência de 1 semana`
        : $localize`:@@training.today.calendar.streak:Sequência de ${weeks}:weeks: semanas`;
  });
  protected readonly remainingLine = computed(() => {
    const remaining = this.remaining();
    if (remaining === null) return '';
    return remaining === 0
      ? $localize`:@@training.today.calendar.goal-complete:Meta da semana concluída`
      : remaining === 1
        ? $localize`:@@training.today.calendar.goal-remaining-one:Falta 1 nesta semana`
        : $localize`:@@training.today.calendar.goal-remaining:Faltam ${remaining}:remaining: nesta semana`;
  });
  protected readonly goalNote = computed(() => {
    const goal = this.effectiveGoal();
    return goal === null
      ? $localize`:@@training.today.calendar.goal-none:Sem meta semanal definida`
      : goal === 1
        ? $localize`:@@training.today.calendar.goal-note-one:Meta semanal: 1 treino`
        : $localize`:@@training.today.calendar.goal-note:Meta semanal: ${goal}:goal: treinos`;
  });
  protected readonly calendarHeading = $localize`:@@training.today.calendar.heading:Mês com Ritmo`;

  constructor() {
    effect(() => {
      this.sessions.revision();
      const week = this.week();
      untracked(() => void this.loadWeek(week));
    });
    effect(() => {
      this.sessions.revision();
      this.calendarEntries.revision();
      const month = this.month();
      if (!this.sheetOpen()) return;
      untracked(() => void this.loadMonth(month));
    });
    effect(() => {
      this.sessions.revision();
      this.calendarEntries.revision();
      // A meta entra na leitura para a sequência acompanhar o ajuste feito na configuração.
      const goal = this.effectiveGoal();
      if (!this.sheetOpen()) return;
      untracked(() => void this.loadStreak(goal));
    });
    effect(() => {
      this.goals.revision();
      untracked(() => void this.loadGoal());
    });
    effect(() => {
      this.calendarEntries.revision();
      const week = this.week();
      untracked(() => void this.loadWeekEntries(week));
    });
    effect(() => {
      this.routines.revision();
      untracked(() => void this.loadPlan());
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

  /**
   * Toque num dia da semana: feito com um treino abre o resumo; planejado (com uma ficha só) escolhe essa ficha para hoje;
   * os demais abrem o mês naquele dia. Sem dia, abre o mês de hoje.
   */
  protected openDay(day?: CalendarDay): void {
    if (day) {
      const workouts = this.weekWorkouts()?.filter((workout) => workout.dayKey === day.key) ?? [];
      if (workouts.length === 1) {
        this.openWorkout(workouts[0]);
        return;
      }
      if (this.stateOf(day, this.weekWorkouts()) === 'planned') {
        const planned = this.plannedRoutineIds(day);
        if (planned.length === 1) {
          this.routineChosen.emit(planned[0]);
          return;
        }
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

  protected isAbsent(key: string, entries: readonly LocalCalendarEntry[]): boolean {
    return entries.some((entry) => entry.dayKey === key && entry.absent);
  }

  /**
   * Estado visual de um dia da semana: feito vence tudo, depois ausência, hoje, planejado (só de hoje em diante) e descanso
   * (dia sem ficha no programa ativo). Dia passado sem treino volta a ser vazio, para não parecer uma pendência eterna.
   */
  protected stateOf(day: CalendarDay, workouts: readonly Workout[] | null): TrainingDayState {
    return this.dayState(day, workouts, this.weekEntries());
  }

  /** O mesmo estado para a grade do mês. */
  protected monthStateOf(day: CalendarDay): TrainingDayState {
    return this.dayState(day, this.monthWorkouts(), this.monthEntries());
  }

  private dayState(
    day: CalendarDay,
    workouts: readonly Workout[] | null,
    entries: readonly LocalCalendarEntry[],
  ): TrainingDayState {
    if (this.hasWorkout(day.key, workouts)) return 'done';
    if (this.isAbsent(day.key, entries)) return 'absent';
    if (this.isToday(day.key)) return 'today';
    const programId = this.planProgramId();
    if (programId === null || !this.isFuture(day.key)) return 'empty';
    return this.plannedRoutineIds(day).length > 0 ? 'planned' : 'rest';
  }

  private plannedRoutineIds(day: CalendarDay): string[] {
    const programId = this.planProgramId();
    if (programId === null) return [];
    const weekday = dateAt(day).getUTCDay() || 7;
    return routinesOnWeekday(this.planRoutines(), weekday, programId).map((routine) => routine.id);
  }

  /**
   * O quanto a ausência pesa na meta de uma semana. Com programa ativo, só pesa o dia ausente que era de treino (viagem de
   * fim de semana num programa de segunda a sexta não muda nada) e a meta cabe nos dias de treino dele; sem programa, todo
   * dia ausente pesa e a meta cabe nos sete dias.
   */
  private absenceOf(
    days: readonly CalendarDay[],
    entries: readonly LocalCalendarEntry[],
  ): { absentDays: number; availableDays: number } {
    const absent = new Set(entries.filter((entry) => entry.absent).map((entry) => entry.dayKey));
    const trainingDays = this.planProgramId() === null ? null : this.programGoal();
    if (trainingDays === null) {
      return { absentDays: days.filter((day) => absent.has(day.key)).length, availableDays: 7 };
    }
    return {
      absentDays: days.filter(
        (day) => absent.has(day.key) && this.plannedRoutineIds(day).length > 0,
      ).length,
      availableDays: trainingDays,
    };
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
    const state = this.stateOf(day, workouts);
    if (state === 'absent')
      return $localize`:@@training.today.calendar.week-day-absent:${visibleDate}:date:, ausência planejada`;
    if (state === 'planned')
      return $localize`:@@training.today.calendar.week-day-planned:${visibleDate}:date:, treino planejado`;
    if (state === 'rest')
      return $localize`:@@training.today.calendar.week-day-rest:${visibleDate}:date:, descanso`;
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

  private async loadWeekEntries(week: ReturnType<typeof sundayWeek>): Promise<void> {
    try {
      this.weekEntries.set(await this.calendarEntries.between(week.days[0].key, week.days[6].key));
    } catch {
      this.weekEntries.set([]);
    }
  }

  /** Fichas e programa ativo para marcar planejado e descanso e para a meta padrão do programa. */
  private async loadPlan(): Promise<void> {
    try {
      const [routines, programId] = await Promise.all([
        this.routines.list(),
        this.routines.activeProgramId(),
      ]);
      this.planRoutines.set(routines);
      this.planProgramId.set(programId);
      this.programGoal.set(programWeeklyGoal(routines, programId));
    } catch {
      this.planRoutines.set([]);
      this.planProgramId.set(null);
      this.programGoal.set(null);
    }
  }

  /** Semanas seguidas com a meta cumprida; ausência planejada não quebra, e a semana em curso só soma quando bate a meta. */
  private async loadStreak(goal: number | null): Promise<void> {
    if (goal === null) {
      this.streak.set(0);
      return;
    }
    try {
      const now = this.runtime.now();
      const weeks = Array.from({ length: STREAK_WEEKS }, (_, back) =>
        sundayWeek(now, -back, this.zone),
      );
      const oldest = weeks[weeks.length - 1];
      const [workouts, entries] = await Promise.all([
        this.readWorkouts(oldest.start, weeks[0].end),
        this.calendarEntries.between(oldest.days[0].key, weeks[0].days[6].key),
      ]);
      const rhythm: WeekRhythm[] = weeks.map((week, back) => {
        const keys = new Set(week.days.map((day) => day.key));
        return {
          goal,
          completed: workouts.filter((workout) => keys.has(workout.dayKey)).length,
          ...this.absenceOf(week.days, entries),
          open: back === 0,
        };
      });
      this.streak.set(weeklyStreak(rhythm));
    } catch {
      this.streak.set(0);
    }
  }

  private async loadMonth(month: CalendarMonth): Promise<void> {
    const ticket = ++this.monthTicket;
    const range = monthRange(month.year, month.month, this.zone);
    try {
      const workouts = await this.readWorkouts(range.start, range.end);
      if (ticket === this.monthTicket)
        this.monthRead.set({ key: `${month.year}-${month.month}`, workouts });
      const entries = await this.calendarEntries.between(
        dateKey(range.start, this.zone),
        dateKey(range.end - 1, this.zone),
      );
      if (ticket === this.monthTicket) this.monthEntries.set(entries);
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
          name: routine?.name ?? $localize`:@@training.today.calendar.free:Treino Livre`,
          sets: working.length,
          volumeKg: working.reduce((sum, set) => sum + (set.weightKg ?? 0) * (set.reps ?? 0), 0),
        };
      }),
    );
    return rows.filter((row): row is Workout => row !== null);
  }
}
