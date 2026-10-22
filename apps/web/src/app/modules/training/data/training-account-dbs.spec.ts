import { TestBed } from '@angular/core/testing';
import { TEST_ACCOUNT } from '../../../core/offline-queue/queue-test-kit';
import type { LocalGoal } from './goals/goal';
import type { LocalRoutine } from './routines/routine';
import type { LocalSession, LocalSet } from './sessions/session';
import { TrainingAccountDbs } from './training-account-dbs';
import { localExercise, setupTraining } from './sync/training-test-kit';
import { TRAINING_TABLES, trainingDbName } from './training-db';

const routine: LocalRoutine = {
  id: 'r1',
  name: 'Treino A',
  position: 0,
  active: true,
  note: '',
  items: [],
  updatedAt: 1,
  clientUpdatedAt: 1,
  deletedAt: null,
} as LocalRoutine;

const session: LocalSession = {
  id: 's1',
  routineId: 'r1',
  startedAt: 1_000,
  finishedAt: null,
  note: '',
  feeling: null,
  deviceId: 'd',
  updatedAt: 1_000,
  clientUpdatedAt: 1_000,
  deletedAt: null,
};

const set: LocalSet = {
  id: 'set1',
  sessionId: 's1',
  exerciseId: 'supino',
  position: 0,
  setType: 'work',
  weightKg: 60,
  reps: 8,
  durationS: null,
  rir: null,
  rpe: null,
  note: '',
  completedAt: 2_000,
  updatedAt: 2_000,
  clientUpdatedAt: 2_000,
  deletedAt: null,
};

const goal: LocalGoal = {
  id: 'weekly-sessions:',
  kind: 'weekly-sessions' as LocalGoal['kind'],
  exerciseId: null,
  value: 4,
  serverId: null,
  updatedAt: 1,
  clientUpdatedAt: 1,
  deletedAt: null,
};

describe('TrainingAccountDbs', () => {
  const dbs = () => TestBed.inject(TrainingAccountDbs);

  it('opens the database of the account by its own name, the same instance every time', () => {
    setupTraining();

    const first = dbs().ensure('conta-a');

    expect(first.db.name).toBe(trainingDbName('conta-a'));
    expect(first.db.name).not.toBe('uniover-training');
    expect(dbs().ensure('conta-a')).toBe(first);
    expect(dbs().lease('conta-a').db).toBe(first.db);
  });

  it('is ready at once for an account that adopts nothing', () => {
    setupTraining();

    expect(dbs().ensure('conta-a').isReady()).toBe(true);
  });

  it('puts the database of the previous account out of use, closing it as soon as nobody uses it', async () => {
    setupTraining();
    const a = dbs().ensure('conta-a');
    await a.db.open();
    expect(a.db.isOpen()).toBe(true);

    const b = dbs().ensure('conta-b');

    expect(b.db).not.toBe(a.db);
    expect(a.db.isOpen()).toBe(false);
  });

  it('never closes a database under a reader: it waits for the lease to be given back', async () => {
    setupTraining();
    const a = dbs().lease('conta-a');
    await a.db.open();

    dbs().ensure('conta-b'); // outra conta entra
    expect(a.db.isOpen()).toBe(true);
    await expect(a.db.exercises.count()).resolves.toBe(0);

    dbs().release(a);
    expect(a.db.isOpen()).toBe(false);
  });

  it('keeps the database of the account in use open even when nobody holds it', async () => {
    setupTraining();
    const a = dbs().lease('conta-a');
    await a.db.open();
    dbs().release(a);

    expect(a.db.isOpen()).toBe(true);
  });

  it('closes the database when the device no longer knows the account', async () => {
    const kit = setupTraining();
    const a = dbs().ensure('conta-a');
    await a.db.open();

    kit.account.signInAs(null);
    TestBed.tick();

    expect(a.db.isOpen()).toBe(false);
  });

  describe('the old database, from before there was one per account', () => {
    async function seedLegacy(kit: ReturnType<typeof setupTraining>) {
      const legacy = kit.trainingLegacyDb();
      await legacy.exercises.bulkPut([localExercise('supino'), localExercise('agachamento')]);
      await legacy.routines.put(routine);
      await legacy.sessions.put(session);
      await legacy.sets.put(set);
      await legacy.goals.put(goal);
      await legacy.syncState.put({ resource: 'exercises', cursor: 'c1', lastPullAt: 5 });
      await legacy.meta.put({ key: 'restEndsAt', value: 123 });
      legacy.close();
    }

    it('is adopted by the first account, table by table, before the database is declared ready', async () => {
      const kit = setupTraining();
      await seedLegacy(kit);
      kit.account.legacyOwner = 'conta-a';

      const a = dbs().ensure('conta-a');
      expect(a.isReady()).toBe(false);
      await a.ready;

      expect(a.isReady()).toBe(true);
      const mine = kit.trainingDbOf('conta-a');
      expect(await mine.exercises.count()).toBe(2);
      expect(await mine.routines.get('r1')).toMatchObject({ name: 'Treino A' });
      expect(await mine.sessions.get('s1')).toMatchObject({ startedAt: 1_000 });
      expect(await mine.sets.get('set1')).toMatchObject({ weightKg: 60, reps: 8 });
      expect(await mine.goals.get(goal.id)).toMatchObject({ value: 4 });
      expect(await mine.syncState.get('exercises')).toMatchObject({ cursor: 'c1' });
      expect((await mine.meta.get('restEndsAt'))?.value).toBe(123);
    });

    it('copies every table of the schema (a new table must be listed for the adoption)', async () => {
      const kit = setupTraining();
      const names = kit.trainingDb.tables.map((table) => table.name).sort();
      expect([...TRAINING_TABLES].sort()).toEqual(names);
    });

    it('is not even looked at again once the adoption finished: the database is ready at once', async () => {
      const kit = setupTraining();
      await seedLegacy(kit);
      kit.account.legacyOwner = 'conta-a';
      await dbs().ensure('conta-a').ready;
      expect(kit.account.adopted.has('uniover-training')).toBe(true);

      dbs().ensure('conta-b'); // sai de cena e volta
      const again = dbs().ensure('conta-a');

      expect(again.isReady()).toBe(true);
    });

    it('is not seen by a second account, which starts empty', async () => {
      const kit = setupTraining();
      await seedLegacy(kit);
      kit.account.legacyOwner = 'conta-a';
      await dbs().ensure('conta-a').ready;

      const b = dbs().ensure('conta-b');
      expect(b.isReady()).toBe(true); // não é a dona: nada a adotar, nada a esperar
      const theirs = kit.trainingDbOf('conta-b');

      for (const table of TRAINING_TABLES) {
        expect(await theirs.table(table).count(), table).toBe(0);
      }
    });

    it('is not taken by an account that is not the owner even if it enters first', async () => {
      const kit = setupTraining();
      await seedLegacy(kit);
      kit.account.legacyOwner = 'conta-a';

      const b = dbs().ensure('conta-b');
      await b.ready;
      expect(await kit.trainingDbOf('conta-b').exercises.count()).toBe(0);

      // E a dona ainda adota depois, quando abre o Treino.
      await dbs().ensure('conta-a').ready;
      expect(await kit.trainingDbOf('conta-a').exercises.count()).toBe(2);
    });
  });

  it('works with the account of the kit by default (the one the screens use)', () => {
    const kit = setupTraining();
    expect(dbs().ensure(TEST_ACCOUNT).db).toBe(kit.trainingDb);
  });
});
