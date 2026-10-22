import Dexie from 'dexie';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { localExercise } from '../sync/training-test-kit';
import {
  TRAINING_SCHEMA_V1,
  TRAINING_SCHEMA_V2,
  TRAINING_SCHEMA_V3,
  TRAINING_SCHEMA_V4,
  TrainingDb,
} from '../training-db';

const FAKE = { IDBKeyRange: FakeIDBKeyRange };

describe('training database, version 3 to 4', () => {
  it('keeps every table of a version 3 database and adds the goals table', async () => {
    const factory = new FakeIDBFactory();
    const name = 'uniover-training-migracao-metas';
    const options = { indexedDB: factory, ...FAKE };

    // O aparelho abriu o app na versão 3 (catálogo, rotinas e treinos) e gravou dados.
    class V3Db extends Dexie {
      constructor() {
        super(name, options);
        this.version(1).stores(TRAINING_SCHEMA_V1);
        this.version(2).stores(TRAINING_SCHEMA_V2);
        this.version(3).stores(TRAINING_SCHEMA_V3);
      }
    }
    const v3 = new V3Db();
    await v3.table('exercises').put(localExercise('supino', { name: 'Supino reto' }));
    await v3.table('meta').put({ key: 'deviceId', value: 'aparelho-1' });
    await v3.table('sessions').put({
      id: 's1',
      routineId: null,
      startedAt: 1,
      finishedAt: 2,
      note: '',
      feeling: null,
      deviceId: 'aparelho-1',
      updatedAt: 1,
      clientUpdatedAt: 1,
      deletedAt: null,
    });
    await v3.table('sets').put({
      id: 'x1',
      sessionId: 's1',
      exerciseId: 'supino',
      position: 0,
      setType: 'work',
      weightKg: 40,
      reps: 10,
      durationS: null,
      rir: null,
      rpe: null,
      note: '',
      completedAt: 1,
      updatedAt: 1,
      clientUpdatedAt: 1,
      deletedAt: null,
    });
    expect(v3.verno).toBe(3);
    v3.close();

    const next = new TrainingDb(name, options);
    await next.open();

    expect(next.verno).toBe(5);
    expect(next.tables.map((table) => table.name).sort()).toEqual([
      'bodyEntries',
      'bodyProfile',
      'exercises',
      'goals',
      'meta',
      'photos',
      'routines',
      'sessions',
      'sets',
      'syncState',
    ]);
    expect((await next.exercises.get('supino'))?.name).toBe('Supino reto');
    expect(await next.meta.get('deviceId')).toEqual({ key: 'deviceId', value: 'aparelho-1' });
    expect((await next.sessions.get('s1'))?.finishedAt).toBe(2);
    expect((await next.sets.get('x1'))?.weightKg).toBe(40);
    // O índice composto das séries continua funcionando, e a tabela nova nasce vazia.
    expect(
      await next.sets
        .where('[exerciseId+completedAt]')
        .between(['supino', 0], ['supino', Number.MAX_SAFE_INTEGER], true, true)
        .count(),
    ).toBe(1);
    expect(await next.goals.count()).toBe(0);

    await next.goals.put({
      id: 'weekly_sessions:',
      kind: 'weekly_sessions',
      exerciseId: null,
      value: 3,
      serverId: null,
      updatedAt: 1,
      clientUpdatedAt: 1,
      deletedAt: null,
    });
    expect((await next.goals.get('weekly_sessions:'))?.value).toBe(3);
    next.close();
  });

  it('has the indexes the goals need', async () => {
    const db = new TrainingDb('uniover-training-indices-metas', {
      indexedDB: new FakeIDBFactory(),
      ...FAKE,
    });
    await db.open();

    expect(db.goals.schema.primKey.name).toBe('id');
    expect(db.goals.schema.indexes.map((index) => index.name).sort()).toEqual([
      'deletedAt',
      'exerciseId',
      'kind',
      'updatedAt',
    ]);
    expect(TRAINING_SCHEMA_V4.goals).toBe('id, kind, exerciseId, updatedAt, deletedAt');
    db.close();
  });

  it('reopening the latest version keeps the goals', async () => {
    const factory = new FakeIDBFactory();
    const name = 'uniover-training-reabrir-metas';
    const first = new TrainingDb(name, { indexedDB: factory, ...FAKE });
    await first.goals.put({
      id: 'daily_kcal:',
      kind: 'daily_kcal',
      exerciseId: null,
      value: 2200,
      serverId: 'abc',
      updatedAt: 5,
      clientUpdatedAt: 5,
      deletedAt: null,
    });
    first.close();

    const again = new TrainingDb(name, { indexedDB: factory, ...FAKE });

    expect((await again.goals.get('daily_kcal:'))?.serverId).toBe('abc');
    again.close();
  });
});
