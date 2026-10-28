import Dexie from 'dexie';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { localExercise } from '../sync/training-test-kit';
import { TRAINING_SCHEMA_V1, TrainingDb } from '../training-db';
import type { LocalRoutine } from './routine';

const FAKE = { IDBKeyRange: FakeIDBKeyRange };

const routine = (id: string, position: number, deletedAt: number | null = null): LocalRoutine => ({
  id,
  name: `Rotina ${id}`,
  position,
  active: true,
  note: '',
  items: [
    {
      id: `${id}-i1`,
      exerciseId: 'supino',
      position: 0,
      targetSets: 3,
      repMin: 8,
      repMax: 12,
      restSeconds: 90,
      supersetGroup: null,
      note: '',
    },
  ],
  updatedAt: 1000,
  clientUpdatedAt: 1000,
  deletedAt,
});

describe('training database, version 1 to the latest', () => {
  it('keeps every table of a version 1 database and adds the routines table', async () => {
    const factory = new FakeIDBFactory();
    const name = 'uniover-training-migracao-rotinas';
    const options = { indexedDB: factory, ...FAKE };

    // O aparelho abriu o app na versão 1 (só o esquema antigo) e gravou dados.
    class V1Db extends Dexie {
      constructor() {
        super(name, options);
        this.version(1).stores(TRAINING_SCHEMA_V1);
      }
    }
    const v1 = new V1Db();
    await v1
      .table('exercises')
      .bulkPut([
        localExercise('a', { name: 'Supino reto', primaryMuscles: ['chest'] }),
        localExercise('b', { name: 'Agachamento', primaryMuscles: ['quadriceps'], deleted: true }),
      ]);
    await v1.table('meta').put({ key: 'seen', value: true });
    await v1.table('syncState').put({ resource: 'exercises', cursor: 'c1', lastPullAt: 1234 });
    expect(v1.verno).toBe(1);
    v1.close();

    // O app novo abre o mesmo banco com o esquema real (a versão mais nova).
    const next = new TrainingDb(name, options);
    await next.open();

    expect(next.verno).toBe(9);
    expect(next.tables.map((table) => table.name).sort()).toEqual([
      'assessmentDocuments',
      'bodyEntries',
      'bodyProfile',
      'calendarEntries',
      'exercises',
      'foods',
      'goals',
      'meals',
      'meta',
      'photos',
      'physicalAssessments',
      'program',
      'routines',
      'sessions',
      'sets',
      'syncState',
    ]);
    const exercises = await next.exercises.orderBy('id').toArray();
    expect(exercises.map((row) => row.id)).toEqual(['a', 'b']);
    expect(exercises[0]).toMatchObject({ name: 'Supino reto', primaryMuscles: ['chest'] });
    expect(exercises[1]).toMatchObject({ name: 'Agachamento', deletedAt: expect.any(Number) });
    expect(await next.meta.get('seen')).toEqual({ key: 'seen', value: true });
    expect(await next.syncState.get('exercises')).toEqual({
      resource: 'exercises',
      cursor: 'c1',
      lastPullAt: 1234,
    });
    // O índice antigo continua funcionando, e a tabela nova nasce vazia, pronta para gravar.
    expect(await next.exercises.where('equipment').equals('barbell').count()).toBe(2);
    expect(await next.routines.count()).toBe(0);

    await next.routines.bulkPut([routine('r2', 1), routine('r1', 0), routine('r3', 2, 5000)]);
    expect((await next.routines.orderBy('position').toArray()).map((row) => row.id)).toEqual([
      'r1',
      'r2',
      'r3',
    ]);
    expect((await next.routines.get('r1'))?.items[0].exerciseId).toBe('supino');
    expect(next.routines.schema.indexes.map((index) => index.name).sort()).toEqual([
      'deletedAt',
      'position',
      'updatedAt',
    ]);
    next.close();
  });

  it('reopening the latest version keeps the routines', async () => {
    const factory = new FakeIDBFactory();
    const name = 'uniover-training-reabertura';
    const options = { indexedDB: factory, ...FAKE };

    const first = new TrainingDb(name, options);
    await first.routines.put(routine('r1', 0));
    first.close();

    const second = new TrainingDb(name, options);
    expect((await second.routines.get('r1'))?.name).toBe('Rotina r1');
    second.close();
  });
});
