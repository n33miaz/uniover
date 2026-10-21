import { TestBed } from '@angular/core/testing';
import { SessionRepository } from '../data/sessions/session-repository';
import { RestTimerService } from '../data/session-live/rest-timer.service';
import { setupSessions } from '../data/sessions/session-data-test-kit';
import type { RoutineItemModel } from '../domain/routines/routine-model';
import { catalog, item, saveRoutine, seedHistory } from '../shell/screen-test-kit';
import { ExerciseHistory } from './exercise-history';
import { DOUBLE_TAP_MS, LiveStore } from './live-store';
import { EMPTY_FIELDS, type SetFields } from './set-draft';
import { SwapStore } from './swap-store';
import { TodayStore } from './today-store';

const fields = (overrides: Partial<SetFields> = {}): SetFields => ({
  ...EMPTY_FIELDS,
  weightKg: 40,
  reps: 10,
  ...overrides,
});

async function setup() {
  // Os provedores da tela entram antes de `setupSessions`, que já cria o módulo de teste.
  TestBed.configureTestingModule({ providers: [TodayStore, LiveStore, ExerciseHistory] });
  const t = setupSessions();
  await t.trainingDb.exercises.bulkPut(catalog());
  localStorage.clear();
  return t;
}

/** Abre um treino da rotina e lê o estado. */
async function begin(items: readonly RoutineItemModel[]) {
  const routine = await saveRoutine('Treino A', items);
  const today = TestBed.inject(TodayStore);
  expect(await today.start(routine.id)).toBe('started');
  const live = TestBed.inject(LiveStore);
  await live.load();
  return { routine, live, today };
}

/** Conclui uma série deixando passar o tempo do toque duplicado. */
async function conclude(
  t: Awaited<ReturnType<typeof setup>>,
  live: LiveStore,
  values: Partial<SetFields> = {},
) {
  t.runtime.advance(DOUBLE_TAP_MS + 100);
  return live.completeSet(fields(values));
}

const A = (overrides: Partial<RoutineItemModel> = {}) =>
  item('a1', 'supino-reto', 0, { targetSets: 3, restSeconds: 120, ...overrides });
const B = (overrides: Partial<RoutineItemModel> = {}) =>
  item('a2', 'agachamento', 1, { targetSets: 3, restSeconds: 60, ...overrides });

describe('LiveStore', () => {
  describe('the series in focus', () => {
    it('starts at the first set, with the same set of last time already filled in and the suggestion ready', async () => {
      const t = await setup();
      await seedHistory(t.trainingDb, 'supino-reto', [[1, 40, 10]]);
      const { live } = await begin([A({ repMin: 8, repMax: 12 })]);
      await vi.waitFor(() => expect(live.info()?.exerciseId).toBe('supino-reto'));

      expect(live.focus()).toMatchObject({
        exerciseId: 'supino-reto',
        setNumber: 1,
        targetSets: 3,
      });
      expect(live.defaults()?.fields).toMatchObject({ weightKg: 40, reps: 10, warmup: false });
      expect(live.info()?.suggestion).toMatchObject({ weightKg: 40, reason: 'within-range' });
    });

    it('starts empty on the load and at the bottom of the rep range when the exercise was never done', async () => {
      const t = await setup();
      const { live } = await begin([A({ repMin: 6, repMax: 10 })]);
      await vi.waitFor(() => expect(live.info()?.last).toBeNull());

      expect(live.defaults()?.fields).toMatchObject({ weightKg: null, reps: 6 });
      expect(live.info()?.suggestion.reason).toBe('no-history');
      expect(t.runtime.now()).toBeGreaterThan(0);
    });

    it('repeats the set just made instead of going back to last time', async () => {
      const t = await setup();
      await seedHistory(t.trainingDb, 'supino-reto', [[1, 40, 10]]);
      const { live } = await begin([A()]);

      await conclude(t, live, { weightKg: 45, reps: 8 });

      expect(live.defaults()?.fields).toMatchObject({ weightKg: 45, reps: 8 });
    });
  });

  describe('concluding a set', () => {
    it('saves on the device first, then starts the rest of the set that was just made (not of the next one)', async () => {
      const t = await setup();
      const { live } = await begin([A({ targetSets: 1 }), B()]);
      const sessions = TestBed.inject(SessionRepository);
      const timer = TestBed.inject(RestTimerService);
      const order: string[] = [];
      const addSet = sessions.addSet.bind(sessions);
      vi.spyOn(sessions, 'addSet').mockImplementation(async (draft) => {
        const result = await addSet(draft);
        order.push('saved');
        return result;
      });
      const start = timer.start.bind(timer);
      vi.spyOn(timer, 'start').mockImplementation(async (seconds) => {
        order.push(`rest ${seconds}`);
        await start(seconds);
      });

      expect(await conclude(t, live)).toBe('saved');

      expect(order).toEqual(['saved', 'rest 120']);
      expect(timer.endsAt()).toBe(t.runtime.now() + 120_000);
      expect(live.focus()).toMatchObject({ exerciseId: 'agachamento', setNumber: 1 });
      expect(await sessions.setsOfSession(live.session()!.id)).toHaveLength(1);
    });

    it('ignores a second tap in less than 600 ms and says so', async () => {
      const t = await setup();
      const { live } = await begin([A()]);

      expect(await conclude(t, live)).toBe('saved');
      t.runtime.advance(DOUBLE_TAP_MS - 100);
      expect(await live.completeSet(fields())).toBe('ignored');

      expect(live.sets()).toHaveLength(1);
      expect(live.notice()?.text).toContain('Toque repetido ignorado');
      t.runtime.advance(200);
      expect(await live.completeSet(fields())).toBe('saved');
      expect(live.sets()).toHaveLength(2);
    });

    it('does not rest in the middle of a superset, and rests after the pair', async () => {
      const t = await setup();
      const timer = TestBed.inject(RestTimerService);
      const { live } = await begin([
        A({ supersetGroup: 1, targetSets: 2 }),
        B({ supersetGroup: 1, targetSets: 2 }),
      ]);

      await conclude(t, live);
      expect(timer.active()).toBe(false);
      expect(live.focus()?.exerciseId).toBe('agachamento');

      await conclude(t, live);
      expect(timer.active()).toBe(true);
      expect(live.focus()).toMatchObject({ exerciseId: 'supino-reto', setNumber: 2 });
    });

    it('records a warm-up without advancing the plan', async () => {
      const t = await setup();
      const { live } = await begin([A()]);

      await conclude(t, live, { warmup: true, weightKg: 20 });

      expect(live.sets()[0].setType).toBe('warmup');
      expect(live.focus()).toMatchObject({ exerciseId: 'supino-reto', setNumber: 1 });
      expect(live.workingSets()).toBe(0);
    });

    it('says what is missing and does not rest when the load was left empty', async () => {
      const t = await setup();
      const timer = TestBed.inject(RestTimerService);
      const { live } = await begin([A()]);

      expect(await conclude(t, live, { weightKg: null })).toBe('invalid');

      expect(live.notice()?.text).toContain('Informe a carga');
      expect(live.issue()).toBe('weight');
      expect(live.sets()).toHaveLength(0);
      expect(timer.active()).toBe(false);
    });

    it('goes on after the last set of the plan with no rest and no focus', async () => {
      const t = await setup();
      const timer = TestBed.inject(RestTimerService);
      const { live } = await begin([A({ targetSets: 1 })]);

      await conclude(t, live);

      expect(live.plan().planDone).toBe(true);
      expect(live.focus()).toBeNull();
      expect(timer.active()).toBe(false);
    });
  });

  describe('records', () => {
    it('warns when the set goes past the heaviest load and the best 1RM estimate, with the old values', async () => {
      const t = await setup();
      await seedHistory(t.trainingDb, 'supino-reto', [[1, 40, 10]]);
      const { live } = await begin([A()]);

      await conclude(t, live, { weightKg: 42.5, reps: 8 });

      await live.settled();
      expect(live.banner()?.maxWeight).toEqual({ previousKg: 40, weightKg: 42.5 });
      expect(live.banner()?.oneRepMax?.valueKg).toBeCloseTo(53.83, 1);
      await vi.waitFor(() => expect(live.recordFlags().size).toBe(1));
    });

    it('says nothing when the exercise has no earlier history', async () => {
      const t = await setup();
      const { live } = await begin([A()]);

      await conclude(t, live, { weightKg: 100, reps: 5 });

      await live.settled();
      expect(live.banner()).toBeNull();
      expect(live.recordFlags().size).toBe(0);
    });

    it('does not warn again for an equal set later in the same workout', async () => {
      const t = await setup();
      await seedHistory(t.trainingDb, 'supino-reto', [[1, 40, 10]]);
      const { live } = await begin([A()]);

      await conclude(t, live, { weightKg: 42.5, reps: 8 });
      await conclude(t, live, { weightKg: 42.5, reps: 8 });

      await live.settled();
      expect(live.banner()).toBeNull();
      await vi.waitFor(() => expect(live.recordFlags().size).toBe(1));
    });
  });

  describe('skipping and choosing', () => {
    it('takes the skipped exercise out of the plan, and brings it back when chosen from the list', async () => {
      const t = await setup();
      const { live } = await begin([A(), B()]);

      await live.skipCurrent();
      expect(live.focus()?.exerciseId).toBe('agachamento');
      expect(await TestBed.inject(SessionRepository).skippedExercises()).toEqual(['supino-reto']);

      const skipped = live.plan().entries.find((entry) => entry.skipped)!;
      await live.choose(skipped.key);
      expect(live.focus()).toMatchObject({ exerciseId: 'supino-reto', chosen: true });
      expect(await TestBed.inject(SessionRepository).skippedExercises()).toEqual([]);
      expect(t.runtime.now()).toBeGreaterThan(0);
    });

    it('offers one more set of a finished exercise, labelled as extra, and then goes back to the plan', async () => {
      const t = await setup();
      const { live } = await begin([A({ targetSets: 1 }), B()]);
      await conclude(t, live);
      expect(live.focus()?.exerciseId).toBe('agachamento');

      await live.choose('item:a1');
      expect(live.focus()).toMatchObject({ exerciseId: 'supino-reto', setNumber: 2, extra: true });

      await conclude(t, live);
      expect(live.focus()).toMatchObject({ exerciseId: 'agachamento', chosen: false });
    });

    it('lets the person add an exercise outside the routine, and keeps it after a reload', async () => {
      const t = await setup();
      const { live } = await begin([A()]);
      const extra = catalog().find((exercise) => exercise.id === 'elevacao')!;

      await live.addExercise(extra);
      expect(live.focus()).toMatchObject({ exerciseId: 'elevacao', extra: true, restSeconds: 90 });
      await live.load();
      expect(live.focusExercise()?.id).toBe('elevacao');

      await conclude(t, live, { weightKg: 8, reps: 12 });
      expect(live.focus()).toMatchObject({ exerciseId: 'elevacao', setNumber: 2 });
    });
  });

  describe('replacing an exercise for today', () => {
    it('does the substitute in the place of the item, keeping its numbers, and saves what was really done', async () => {
      const t = await setup();
      const { live } = await begin([A(), B()]);
      const other = catalog().find((exercise) => exercise.id === 'supino-inclinado')!;

      expect(await live.swapCurrent(other)).toBe('swapped');
      expect(live.focus()).toMatchObject({
        exerciseId: 'supino-inclinado',
        planExerciseId: 'supino-reto',
        setNumber: 1,
        targetSets: 3,
        swapped: true,
      });

      await conclude(t, live);
      expect(live.sets()[0].exerciseId).toBe('supino-inclinado');
      expect(live.focus()).toMatchObject({ exerciseId: 'supino-inclinado', setNumber: 2 });
    });

    it('survives a reload: a new store reads the swap and goes on at the same set', async () => {
      const t = await setup();
      const { live, routine } = await begin([A(), B()]);
      const other = catalog().find((exercise) => exercise.id === 'supino-inclinado')!;
      await live.swapCurrent(other);
      await conclude(t, live);

      // "Recarregar": uma instância nova do estado, com o mesmo banco e o mesmo armazenamento do aparelho.
      const reloaded = TestBed.runInInjectionContext(() => new LiveStore());
      await reloaded.load();

      expect(reloaded.session()?.routineId).toBe(routine.id);
      expect(reloaded.focus()).toMatchObject({
        exerciseId: 'supino-inclinado',
        setNumber: 2,
        swapped: true,
      });
    });

    it('refuses an exercise that is already in the routine, and goes back to the original on request', async () => {
      const t = await setup();
      const { live } = await begin([A(), B()]);
      const catalogRows = catalog();
      const squat = catalogRows.find((exercise) => exercise.id === 'agachamento')!;
      const inclined = catalogRows.find((exercise) => exercise.id === 'supino-inclinado')!;
      const bench = catalogRows.find((exercise) => exercise.id === 'supino-reto')!;

      expect(await live.swapCurrent(squat)).toBe('in-routine');
      expect(await live.swapCurrent(inclined)).toBe('swapped');
      expect(await live.swapCurrent(bench)).toBe('restored');
      expect(live.focus()).toMatchObject({ exerciseId: 'supino-reto', swapped: false });
      expect(TestBed.inject(SwapStore).read(live.session()!.id).size).toBe(0);
      expect(t.runtime.now()).toBeGreaterThan(0);
    });
  });

  describe('free workout', () => {
    it('has no exercise until one is chosen, then rests 90 s between sets', async () => {
      const t = await setup();
      const today = TestBed.inject(TodayStore);
      await today.start(null);
      const live = TestBed.inject(LiveStore);
      await live.load();
      expect(live.focus()).toBeNull();
      expect(live.plan().planDone).toBe(false);

      await live.addExercise(catalog().find((exercise) => exercise.id === 'agachamento')!);
      await conclude(t, live, { weightKg: 60, reps: 8 });

      expect(TestBed.inject(RestTimerService).endsAt()).toBe(t.runtime.now() + 90_000);
      expect(live.focus()).toMatchObject({ exerciseId: 'agachamento', setNumber: 2 });
    });
  });

  describe('editing and ending', () => {
    it('edits and deletes a set that was already saved', async () => {
      const t = await setup();
      const { live } = await begin([A()]);
      await conclude(t, live, { weightKg: 40, reps: 10 });
      const set = live.sets()[0];

      expect(await live.editSet(set, fields({ weightKg: 42.5, reps: 9, rpe: 8 }))).toBeNull();
      await live.load();
      expect(live.sets()[0]).toMatchObject({ weightKg: 42.5, reps: 9, rpe: 8 });

      expect(await live.deleteSet(set.id)).toBe(true);
      await live.load();
      expect(live.sets()).toHaveLength(0);
    });

    it('finishes the workout, clears the swaps and the rest, and gives the id for the summary', async () => {
      const t = await setup();
      const { live } = await begin([A(), B()]);
      await live.swapCurrent(catalog().find((exercise) => exercise.id === 'supino-inclinado')!);
      await conclude(t, live);
      const id = live.session()!.id;

      expect(await live.finish()).toBe(id);

      expect(TestBed.inject(RestTimerService).active()).toBe(false);
      expect(TestBed.inject(SwapStore).read(id).size).toBe(0);
      expect(await TestBed.inject(SessionRepository).activeSession()).toBeUndefined();
    });

    it('cancels the workout: the sets go away with it', async () => {
      const t = await setup();
      const { live } = await begin([A()]);
      await conclude(t, live);

      expect(await live.discard()).toBe(true);
      await live.load();

      expect(live.session()).toBeUndefined();
      expect(live.sets()).toEqual([]);
    });
  });

  describe('when the local database cannot be read', () => {
    it('leaves the screen ready and empty instead of throwing', async () => {
      await setup();
      vi.spyOn(TestBed.inject(SessionRepository), 'activeSession').mockRejectedValue(
        new Error('IndexedDB API missing'),
      );
      const live = TestBed.inject(LiveStore);

      await expect(live.load()).resolves.toBeUndefined();

      expect(live.ready()).toBe(true);
      expect(live.session()).toBeUndefined();
    });

    it('goes on without the last time and the suggestion when they cannot be read', async () => {
      await setup();
      const read = vi
        .spyOn(TestBed.inject(SessionRepository), 'lastPerformance')
        .mockRejectedValue(new Error('IndexedDB API missing'));
      const { live } = await begin([A()]);

      await vi.waitFor(() => expect(read).toHaveBeenCalled());

      expect(live.session()).toBeDefined();
      expect(live.info()).toBeNull();
    });
  });

  describe('summary', () => {
    it('adds the volume by hand, leaves the warm-up out and lists the records with the old value', async () => {
      const t = await setup();
      await seedHistory(t.trainingDb, 'supino-reto', [[1, 40, 10]]);
      const { live } = await begin([A({ targetSets: 2 })]);
      await conclude(t, live, { warmup: true, weightKg: 20, reps: 10 });
      await conclude(t, live, { weightKg: 40, reps: 10 });
      await conclude(t, live, { weightKg: 42.5, reps: 8 });
      t.runtime.advance(30 * 60_000);
      const id = (await live.finish())!;

      const data = (await live.loadSummary(id))!;

      // 40 × 10 + 42,5 × 8 = 400 + 340; o aquecimento (20 × 10) não entra.
      expect(data.summary.volumeKg).toBe(740);
      expect(data.summary.workingSets).toBe(2);
      expect(data.summary.warmupSets).toBe(1);
      expect(data.summary.durationMs).toBeGreaterThanOrEqual(30 * 60_000);
      expect(data.routineName).toBe('Treino A');
      expect(
        data.records.map((record) => [record.kind, record.previousKg, record.valueKg]),
      ).toEqual([
        ['maxWeight', 40, 42.5],
        ['oneRepMax', expect.closeTo(53.33, 1), expect.closeTo(53.83, 1)],
      ]);
    });

    it('does not find a workout that is still open', async () => {
      await setup();
      const { live } = await begin([A()]);

      expect(await live.loadSummary(live.session()!.id)).toBeNull();
    });
  });
});
