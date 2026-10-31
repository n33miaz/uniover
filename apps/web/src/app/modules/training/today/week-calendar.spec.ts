import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { catalog, eventually, setupScreen } from '../shell/screen-test-kit';
import { QUEUE_RUNTIME } from '../../../core/offline-queue/queue-ports';
import { CalendarEntryRepository } from '../data/calendar/calendar-entry-repository';
import { GoalRepository } from '../data/goals/goal-repository';
import { WeekCalendar } from './week-calendar';

describe('WeekCalendar', () => {
  afterEach(() => localStorage.clear());

  it('opens the local summary when a completed workout day is touched', async () => {
    const kit = await setupScreen([{ path: 'treino', component: WeekCalendar }]);
    const finishedAt = kit.runtime.now() - 30 * 60_000;
    await kit.trainingDb.exercises.bulkPut(catalog());
    await kit.trainingDb.sessions.put({
      id: 'past-session',
      routineId: null,
      startedAt: finishedAt - 45 * 60_000,
      finishedAt,
      note: '',
      feeling: null,
      deviceId: 'another-device',
      updatedAt: finishedAt,
      clientUpdatedAt: finishedAt,
      deletedAt: null,
    });
    await kit.trainingDb.sets.put({
      id: 'past-set',
      sessionId: 'past-session',
      exerciseId: 'supino-reto',
      position: 0,
      setType: 'work',
      weightKg: 40,
      reps: 10,
      durationS: null,
      rir: null,
      rpe: null,
      note: '',
      completedAt: finishedAt - 10 * 60_000,
      updatedAt: finishedAt,
      clientUpdatedAt: finishedAt,
      deletedAt: null,
    });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const harness = await kit.harness();
    await harness.navigateByUrl('/treino', WeekCalendar);
    const fixture = harness.fixture;
    const element = harness.routeNativeElement as HTMLElement;

    await eventually(fixture, () => expect(element.querySelector('.day.done')).not.toBeNull());
    element.querySelector<HTMLButtonElement>('.day.done')!.click();

    expect(navigate).toHaveBeenCalledWith(['/treino'], {
      queryParams: { resumo: 'past-session', historico: '1' },
    });
  });
});

describe('WeekCalendar agenda', () => {
  afterEach(() => localStorage.clear());

  const DAY = 86_400_000;

  /** Um treino encerrado com uma série de trabalho, começando em `startedAt`. */
  async function workout(
    kit: Awaited<ReturnType<typeof setupScreen>>,
    id: string,
    startedAt: number,
  ): Promise<void> {
    const finishedAt = startedAt + 40 * 60_000;
    await kit.trainingDb.sessions.put({
      id,
      routineId: null,
      startedAt,
      finishedAt,
      note: '',
      feeling: null,
      deviceId: 'another-device',
      updatedAt: finishedAt,
      clientUpdatedAt: finishedAt,
      deletedAt: null,
    });
    await kit.trainingDb.sets.put({
      id: `${id}-set`,
      sessionId: id,
      exerciseId: 'supino-reto',
      position: 0,
      setType: 'work',
      weightKg: 40,
      reps: 10,
      durationS: null,
      rir: null,
      rpe: null,
      note: '',
      completedAt: startedAt + 10 * 60_000,
      updatedAt: finishedAt,
      clientUpdatedAt: finishedAt,
      deletedAt: null,
    });
  }

  /** O programa ativo `p` com uma ficha que treina segunda, quarta e sexta. */
  async function seedProgram(kit: Awaited<ReturnType<typeof setupScreen>>): Promise<void> {
    await kit.trainingDb.program.put({
      id: 'active',
      programId: 'p',
      updatedAt: 1,
      clientUpdatedAt: 1,
    });
    await kit.trainingDb.routines.put({
      id: 'r1',
      name: 'Treino A',
      position: 0,
      active: true,
      note: '',
      items: [],
      programId: 'p',
      weekdays: [1, 3, 5],
      updatedAt: 1,
      clientUpdatedAt: 1,
      deletedAt: null,
    });
  }

  async function open() {
    const kit = await setupScreen([{ path: 'treino', component: WeekCalendar }]);
    await kit.trainingDb.exercises.bulkPut(catalog());
    return kit;
  }

  async function render(kit: Awaited<ReturnType<typeof setupScreen>>) {
    const harness = await kit.harness();
    await harness.navigateByUrl('/treino', WeekCalendar);
    return {
      fixture: harness.fixture,
      element: harness.routeNativeElement as HTMLElement,
      calendar: harness.routeDebugElement!.componentInstance as WeekCalendar,
    };
  }

  it('marks today, planned and rest days from the program, and shows the goal from its training days', async () => {
    const kit = await open();
    await seedProgram(kit);
    const { fixture, element } = await render(kit);

    // O relógio falso cai numa quinta: a sexta é de treino e o sábado (a semana vai até ele) é de descanso;
    // o que já passou, domingo inclusive, fica vazio.
    await eventually(fixture, () => {
      expect(element.querySelectorAll('.day.planned')).toHaveLength(1);
      expect(element.querySelectorAll('.day.rest')).toHaveLength(1);
    });
    expect(element.querySelectorAll('.day.today')).toHaveLength(1);
    expect(element.querySelector('.week-count')?.textContent).toContain('0 de 3');
    expect(element.querySelector('#week-title')?.textContent?.trim()).toBe('Esta Semana');
    expect(element.querySelector('.week-progress span')?.textContent?.trim()).toBe(
      'Faltam 3 nesta semana',
    );
  });

  it('starts on Sunday and always shows the week totals, with the volume', async () => {
    const kit = await open();
    await TestBed.inject(GoalRepository).set('weekly_sessions', 2);
    await workout(kit, 'w0', kit.runtime.now() - 60 * 60_000);
    const { fixture, element } = await render(kit);

    await eventually(fixture, () => expect(element.querySelector('.day.done')).not.toBeNull());
    const labels = Array.from(element.querySelectorAll('.week-days .weekday')).map((day) =>
      day.textContent?.trim(),
    );
    expect(labels).toEqual(['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']);
    const totals = Array.from(element.querySelectorAll('.stats div')).map((cell) => [
      cell.querySelector('dt')?.textContent?.trim(),
      cell.querySelector('dd')?.textContent?.trim(),
    ]);
    // Uma série de 40 kg × 10: 1 treino, 1 série e 400 kg de volume.
    expect(totals).toEqual([
      ['Treinos', '1'],
      ['Séries', '1'],
      ['Volume', expect.stringContaining('400')],
    ]);
    expect(element.querySelector('.week-count')?.textContent).toContain('1 de 2');
  });

  it('drops a slow absence read that comes back after the week was already changed', async () => {
    const kit = await open();
    const entries = TestBed.inject(CalendarEntryRepository);
    const entryOf = (dayKey: string) => ({
      id: dayKey,
      dayKey,
      absent: true,
      note: '',
      updatedAt: 1,
      clientUpdatedAt: 1,
      deletedAt: null,
    });
    // A leitura da semana atual fica pendurada; a da semana seguinte volta na hora.
    const gate: { release?: () => void } = {};
    let first = true;
    vi.spyOn(entries, 'between').mockImplementation((from: string) => {
      if (first) {
        first = false;
        return new Promise((resolve) => {
          gate.release = () => resolve([entryOf(from)]);
        });
      }
      return Promise.resolve([entryOf(from)]);
    });
    const { fixture, element } = await render(kit);
    await eventually(fixture, () => expect(gate.release).toBeDefined());

    element.querySelector<HTMLButtonElement>('button[aria-label="Próxima semana"]')!.click();
    // Na semana seguinte, o domingo está ausente (o que a leitura rápida trouxe).
    await eventually(fixture, () =>
      expect(element.querySelector('.week-days .day:first-child')?.classList).toContain('absent'),
    );

    // A leitura lenta da semana anterior chega por último e não pode apagar o que a tela já mostra.
    gate.release!();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelectorAll('.week-days .day.absent')).toHaveLength(1);
    expect(element.querySelector('.week-days .day:first-child')?.classList).toContain('absent');
  });

  it('moves to the new week when the person returns to the app after midnight on Sunday', async () => {
    const kit = await open();
    const { fixture, element } = await render(kit);
    const firstDay = () =>
      element.querySelector('.week-days .day:first-child .number')?.textContent;
    const todayLabel = () =>
      element.querySelector('.week-days .day.today')?.getAttribute('aria-label');
    const before = { first: firstDay(), today: todayLabel() };

    // O relógio falso cai numa quinta; cinco dias depois já é a terça da semana seguinte.
    kit.runtime.advance(5 * DAY);
    window.dispatchEvent(new Event('focus'));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(firstDay()).not.toBe(before.first);
    expect(todayLabel()).not.toBe(before.today);
    expect(element.querySelectorAll('.week-days .day.today')).toHaveLength(1);
  });

  it('selects the routine of a planned day when it is touched', async () => {
    const kit = await open();
    await seedProgram(kit);
    const { fixture, element, calendar } = await render(kit);
    await eventually(fixture, () => expect(element.querySelector('.day.planned')).not.toBeNull());

    const chosen: string[] = [];
    calendar.routineChosen.subscribe((id) => chosen.push(id));
    element.querySelector<HTMLButtonElement>('.day.planned')!.click();

    expect(chosen).toEqual(['r1']);
  });

  it('lowers what is missing only for absence on training days, and drops them out of the planned marks', async () => {
    const kit = await open();
    await seedProgram(kit);
    const entries = TestBed.inject(CalendarEntryRepository);
    const { fixture, element } = await render(kit);
    await eventually(fixture, () => expect(element.querySelector('.day.planned')).not.toBeNull());

    expect(element.querySelector('.day.planned')?.getAttribute('aria-label')).toContain(
      'treino planejado',
    );
    // Sexta, sábado e segunda viram ausência: três dias tiram a parte deles da meta de três.
    const start = TestBed.inject(QUEUE_RUNTIME).now();
    const dayKeyOf = (offset: number) => new Date(start + offset * DAY).toISOString().slice(0, 10);
    await entries.save(dayKeyOf(1), { absent: true, note: '' });
    await entries.save(dayKeyOf(2), { absent: true, note: '' });
    await entries.save(dayKeyOf(-3), { absent: true, note: '' });

    await eventually(fixture, () => {
      expect(element.querySelectorAll('.day.absent')).toHaveLength(3);
      expect(element.querySelectorAll('.day.planned')).toHaveLength(0);
    });
    // Sexta e segunda eram de treino (sábado é descanso): duas das três sessões saem da meta, e sobra uma por fazer.
    await eventually(fixture, () =>
      expect(element.querySelector('.week-progress')?.textContent).toContain(
        'Falta 1 nesta semana',
      ),
    );
  });

  it('counts consecutive met weeks in the month view, with a goal set by the person', async () => {
    const kit = await open();
    const now = kit.runtime.now();
    await TestBed.inject(GoalRepository).set('weekly_sessions', 1);
    await workout(kit, 'w0', now - 60 * 60_000);
    await workout(kit, 'w1', now - 7 * DAY);
    await workout(kit, 'w2', now - 14 * DAY);
    const { fixture, element } = await render(kit);

    await eventually(fixture, () => expect(element.querySelector('.day.done')).not.toBeNull());
    element.querySelector<HTMLButtonElement>('.calendar-link')!.click();
    await eventually(fixture, () =>
      expect(document.body.querySelector('.streak')?.textContent).toContain('3 semanas'),
    );
  });
});
