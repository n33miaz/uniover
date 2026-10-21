import { TestBed } from '@angular/core/testing';
import { OfflineQueue } from '../../../core/offline-queue/offline-queue';
import { CatalogRepository } from '../data/catalog/catalog-repository';
import { RoutineRepository } from '../data/routines/routine-repository';
import { SessionRepository } from '../data/sessions/session-repository';
import { setupSessions } from '../data/sessions/session-data-test-kit';
import { catalog, item, saveRoutine, seedHistory } from '../shell/screen-test-kit';
import { ExerciseHistory } from './exercise-history';
import { DOUBLE_TAP_MS, LiveStore } from './live-store';
import { EMPTY_FIELDS } from './set-draft';
import { SwapStore } from './swap-store';
import { FORGOTTEN_AFTER_MS, TodayStore } from './today-store';

const HOUR = 3_600_000;

async function setup() {
  // Os provedores da tela entram antes de `setupSessions`, que já cria o módulo de teste.
  TestBed.configureTestingModule({ providers: [TodayStore, LiveStore, ExerciseHistory] });
  const t = setupSessions();
  await t.trainingDb.exercises.bulkPut(catalog());
  localStorage.clear();
  return t;
}

/** Um treino que ficou aberto em outro aparelho, aberto há `ageMs`. */
async function openElsewhere(t: Awaited<ReturnType<typeof setup>>, ageMs: number) {
  const startedAt = t.runtime.now() - ageMs;
  await t.trainingDb.sessions.put({
    id: 'treino-do-outro',
    routineId: null,
    startedAt,
    finishedAt: null,
    note: '',
    feeling: null,
    deviceId: 'outro-aparelho',
    updatedAt: startedAt,
    clientUpdatedAt: startedAt,
    deletedAt: null,
  });
}

describe('TodayStore', () => {
  describe('workouts open somewhere', () => {
    it('knows there is no open workout, here or elsewhere', async () => {
      await setup();
      const store = TestBed.inject(TodayStore);

      await store.loadCore();

      expect(store.ready()).toBe(true);
      expect(store.active()).toBeUndefined();
      expect(store.otherDevice()).toBeUndefined();
    });

    it('blocks a second device, and only offers to end the forgotten workout after 12 hours', async () => {
      const t = await setup();
      const store = TestBed.inject(TodayStore);
      await openElsewhere(t, 5 * HOUR);

      await store.loadCore();
      expect(store.otherDevice()).toMatchObject({ forgotten: false });
      expect(await store.start(null)).toBe('blocked');

      await t.trainingDb.sessions.update('treino-do-outro', {
        startedAt: t.runtime.now() - FORGOTTEN_AFTER_MS - HOUR,
      });
      await store.loadCore();
      expect(store.otherDevice()).toMatchObject({ forgotten: true });
    });

    it('keeps the swaps of the open workout when asked to start again, and drops them for a new workout', async () => {
      await setup();
      const swaps = TestBed.inject(SwapStore);
      const store = TestBed.inject(TodayStore);
      expect(await store.start(null)).toBe('started');
      const id = (await TestBed.inject(SessionRepository).activeSession())!.id;
      swaps.write(id, new Map([['item', 'outro-exercicio']]));

      expect(await store.start(null)).toBe('resumed');
      expect(swaps.read(id).size).toBe(1);

      await TestBed.inject(SessionRepository).finish();
      expect(await store.start(null)).toBe('started');
      expect(swaps.read(id).size).toBe(0);
    });

    it('ends the forgotten workout from here and then lets this device start', async () => {
      const t = await setup();
      const store = TestBed.inject(TodayStore);
      await openElsewhere(t, 13 * HOUR);
      await store.loadCore();

      expect(await store.closeForgotten('treino-do-outro')).toBe(true);
      expect(store.otherDevice()).toBeUndefined();
      expect(await store.start(null)).toBe('started');
      expect(await store.start(null)).toBe('resumed');
    });
  });

  describe('the routine of the day', () => {
    it('shows the next routine of the sequence, and the one the person chose instead', async () => {
      await setup();
      const a = await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
      const b = await saveRoutine('Treino B', [item('b1', 'agachamento', 0)]);
      const store = TestBed.inject(TodayStore);

      await store.loadHome();
      expect(store.selected()?.routine.id).toBe(a.id);
      expect(store.selected()?.next).toBe(true);

      store.chooseRoutine(b.id);
      expect(store.selected()?.routine.id).toBe(b.id);
    });

    it('lines carry the last time and a higher load only when the suggestion goes up', async () => {
      const t = await setup();
      // Três séries no topo da faixa (10): a sugestão sobe um degrau de 2,5 kg. No agachamento a faixa não fechou.
      await seedHistory(t.trainingDb, 'supino-reto', [
        [1, 40, 10],
        [1, 40, 10],
        [1, 40, 10],
      ]);
      await seedHistory(t.trainingDb, 'agachamento', [[1, 60, 8]]);
      await saveRoutine('Treino A', [
        item('a1', 'supino-reto', 0, { targetSets: 3, repMin: 6, repMax: 10 }),
        item('a2', 'agachamento', 1, { targetSets: 3, repMin: 6, repMax: 10, supersetGroup: 1 }),
        item('a3', 'prancha', 2, { supersetGroup: 1 }),
      ]);
      const store = TestBed.inject(TodayStore);

      await store.loadHome();
      TestBed.tick();
      await vi.waitFor(() => expect(store.lines()).toHaveLength(3));

      const [bench, squat, plank] = store.lines();
      expect(bench).toMatchObject({
        name: 'Supino reto com barra',
        last: '40 kg × 10',
        tryKg: 42.5,
      });
      expect(squat).toMatchObject({ last: '60 kg × 8', tryKg: null, superset: true });
      expect(plank).toMatchObject({ last: null, tryKg: null, superset: true });
    });
  });

  describe('what the queue holds', () => {
    it('counts one waiting set per set (an edit is not another set) and sees a workout the server refused', async () => {
      const t = await setup();
      const routine = await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
      const store = TestBed.inject(TodayStore);
      await store.start(routine.id);
      const live = TestBed.inject(LiveStore);
      await live.load();
      for (let n = 0; n < 2; n++) {
        t.runtime.advance(DOUBLE_TAP_MS + 100);
        await live.completeSet({ ...EMPTY_FIELDS, weightKg: 40, reps: 10 });
      }
      await live.editSet(live.sets()[0], { ...EMPTY_FIELDS, weightKg: 42.5, reps: 10 });
      const id = live.session()!.id;

      await store.readQueue();
      expect(store.awaitingSetsOf(id)).toBe(2);
      expect(store.failedSessionIds()).toEqual([]);

      const items = await t.db.outbox.toArray();
      const sessionItem = items.find((entry) => entry.url.endsWith(`/sessions/${id}`))!;
      await t.db.outbox.update(sessionItem.id, { status: 'failed', lastError: 'http-409' });
      await store.readQueue();
      expect(store.failedSessionIds()).toEqual([id]);

      expect(await store.resendFailed()).toBe(true);
      expect(store.failedSessionIds()).toEqual([]);
      expect((await t.db.outbox.toArray()).some((entry) => entry.status === 'failed')).toBe(false);
      expect(TestBed.inject(SessionRepository)).toBeTruthy();
    });
  });

  describe('when the local database cannot be read', () => {
    // Navegador sem IndexedDB, ou banco fechado por outra aba: a tela segue com o estado vazio, sem erro solto.
    const down = new Error('IndexedDB API missing');

    it('treats the missing database as an empty state: ready, no routines, no catalog', async () => {
      await setup();
      vi.spyOn(TestBed.inject(SessionRepository), 'activeSession').mockRejectedValue(down);
      vi.spyOn(TestBed.inject(RoutineRepository), 'all').mockRejectedValue(down);
      vi.spyOn(TestBed.inject(CatalogRepository), 'count').mockRejectedValue(down);
      vi.spyOn(TestBed.inject(OfflineQueue), 'items').mockRejectedValue(down);
      const store = TestBed.inject(TodayStore);

      await expect(store.loadCore()).resolves.toBeUndefined();
      await expect(store.loadHome()).resolves.toBeUndefined();
      await expect(store.loadCatalogCount()).resolves.toBeUndefined();
      await expect(store.readQueue()).resolves.toBeUndefined();

      expect(store.ready()).toBe(true);
      expect(store.homeReady()).toBe(true);
      expect(store.catalogCount()).toBe(0);
      expect(store.entries()).toEqual([]);
      expect(store.failedSessionIds()).toEqual([]);
    });

    it('keeps the routine of the day without the "last time" lines when the history cannot be read', async () => {
      await setup();
      await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
      const read = vi.spyOn(TestBed.inject(CatalogRepository), 'get').mockRejectedValue(down);
      const store = TestBed.inject(TodayStore);

      await store.loadHome();
      TestBed.tick();
      await vi.waitFor(() => expect(read).toHaveBeenCalled());

      expect(store.selected()?.routine.name).toBe('Treino A');
      expect(store.lines()).toEqual([]);
    });
  });
});
