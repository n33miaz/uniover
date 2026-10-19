import Dexie from 'dexie';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { localExercise } from '../sync/training-test-kit';
import { TRAINING_SCHEMA_V1, TRAINING_SCHEMA_V2, TrainingDb } from '../training-db';
import { toLocalSession, toLocalSet } from './session';
import { sessionDto, setDto } from './session-data-test-kit';

const FAKE = { IDBKeyRange: FakeIDBKeyRange };

describe('training database, version 2 to 3', () => {
  it('keeps every table of a version 2 database and adds sessions and sets', async () => {
    const factory = new FakeIDBFactory();
    const name = 'uniover-training-migracao-sessoes';
    const options = { indexedDB: factory, ...FAKE };

    // O aparelho abriu o app na versão 2 (catálogo e rotinas) e gravou dados.
    class V2Db extends Dexie {
      constructor() {
        super(name, options);
        this.version(1).stores(TRAINING_SCHEMA_V1);
        this.version(2).stores(TRAINING_SCHEMA_V2);
      }
    }
    const v2 = new V2Db();
    await v2.table('exercises').put(localExercise('supino', { name: 'Supino reto' }));
    await v2.table('meta').put({ key: 'seen', value: true });
    await v2.table('syncState').put({ resource: 'routines', cursor: 'c2', lastPullAt: 99 });
    await v2.table('routines').put({
      id: 'r1',
      name: 'A',
      position: 0,
      active: true,
      note: '',
      items: [],
      updatedAt: 1,
      clientUpdatedAt: 1,
      deletedAt: null,
    });
    expect(v2.verno).toBe(2);
    v2.close();

    const next = new TrainingDb(name, options);
    await next.open();

    expect(next.verno).toBe(3);
    expect(next.tables.map((table) => table.name).sort()).toEqual([
      'exercises',
      'meta',
      'routines',
      'sessions',
      'sets',
      'syncState',
    ]);
    expect((await next.exercises.get('supino'))?.name).toBe('Supino reto');
    expect(await next.meta.get('seen')).toEqual({ key: 'seen', value: true });
    expect(await next.syncState.get('routines')).toEqual({
      resource: 'routines',
      cursor: 'c2',
      lastPullAt: 99,
    });
    expect((await next.routines.get('r1'))?.name).toBe('A');
    expect(await next.sessions.count()).toBe(0);
    expect(await next.sets.count()).toBe(0);
    next.close();
  });

  it('has the indexes the history needs, including the composite one with explicit bounds', async () => {
    const db = new TrainingDb('uniover-training-indices-sessoes', {
      indexedDB: new FakeIDBFactory(),
      ...FAKE,
    });
    await db.open();

    expect(db.sessions.schema.indexes.map((index) => index.name).sort()).toEqual([
      'deletedAt',
      'deviceId',
      'finishedAt',
      'routineId',
      'startedAt',
      'updatedAt',
    ]);
    expect(db.sets.schema.indexes.map((index) => index.name).sort()).toEqual([
      '[exerciseId+completedAt]',
      'completedAt',
      'deletedAt',
      'exerciseId',
      'sessionId',
    ]);

    await db.sessions.put(toLocalSession(sessionDto('s1')));
    await db.sets.bulkPut([
      { ...toLocalSet(setDto('a', 's1', { exerciseId: 'supino' })), completedAt: 100 },
      { ...toLocalSet(setDto('b', 's1', { exerciseId: 'supino' })), completedAt: 300 },
      { ...toLocalSet(setDto('c', 's1', { exerciseId: 'agacha' })), completedAt: 200 },
    ]);
    const history = await db.sets
      .where('[exerciseId+completedAt]')
      .between(['supino', 0], ['supino', Number.MAX_SAFE_INTEGER], true, true)
      .reverse()
      .toArray();

    expect(history.map((row) => row.id)).toEqual(['b', 'a']);
    db.close();
  });

  it('reopening keeps the sessions and the sets', async () => {
    const factory = new FakeIDBFactory();
    const name = 'uniover-training-reabertura-sessoes';
    const options = { indexedDB: factory, ...FAKE };

    const first = new TrainingDb(name, options);
    await first.sessions.put(toLocalSession(sessionDto('s1')));
    await first.sets.put(toLocalSet(setDto('t1', 's1')));
    first.close();

    const second = new TrainingDb(name, options);
    expect((await second.sessions.get('s1'))?.deviceId).toBe('outro-aparelho');
    expect((await second.sets.get('t1'))?.weightKg).toBe(80);
    second.close();
  });
});
