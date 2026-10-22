import Dexie from 'dexie';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { DATABASE_NAME as OFFLINE_DATABASE_NAME } from '../../../core/offline-queue/offline-db';
import { localExercise } from './sync/training-test-kit';
import {
  TRAINING_DB_NAME,
  TRAINING_SCHEMA_V1,
  TRAINING_SCHEMA_V2,
  TRAINING_SCHEMA_V3,
  TRAINING_SCHEMA_V4,
  TRAINING_SCHEMA_V5,
  TrainingDb,
} from './training-db';

const FAKE = { IDBKeyRange: FakeIDBKeyRange };

describe('TrainingDb', () => {
  it('is a database apart from the offline queue one', () => {
    expect(TRAINING_DB_NAME).toBe('uniover-training');
    expect(TRAINING_DB_NAME).not.toBe(OFFLINE_DATABASE_NAME);
  });

  it('opens at version 6 with the existing training data and local assessment tables', async () => {
    const db = new TrainingDb('uniover-training-esquema', {
      indexedDB: new FakeIDBFactory(),
      ...FAKE,
    });
    await db.open();

    expect(db.verno).toBe(6);
    expect(db.tables.map((table) => table.name).sort()).toEqual([
      'assessmentDocuments',
      'bodyEntries',
      'bodyProfile',
      'exercises',
      'goals',
      'meta',
      'photos',
      'physicalAssessments',
      'routines',
      'sessions',
      'sets',
      'syncState',
    ]);
    expect(db.exercises.schema.primKey.name).toBe('id');
    const indexes = db.exercises.schema.indexes;
    expect(indexes.map((index) => index.name).sort()).toEqual([
      'deletedAt',
      'equipment',
      'nameKey',
      'primaryMuscles',
      'slug',
    ]);
    expect(indexes.find((index) => index.name === 'primaryMuscles')?.multi).toBe(true);
    expect(db.meta.schema.primKey.name).toBe('key');
    expect(db.syncState.schema.primKey.name).toBe('resource');
    db.close();
  });

  it('migrates version 5 without changing existing rows and creates empty assessment tables', async () => {
    const factory = new FakeIDBFactory();
    const name = 'uniover-training-avaliacoes-v5';
    const options = { indexedDB: factory, ...FAKE };
    class V5Db extends Dexie {
      constructor() {
        super(name, options);
        this.version(1).stores(TRAINING_SCHEMA_V1);
        this.version(2).stores(TRAINING_SCHEMA_V2);
        this.version(3).stores(TRAINING_SCHEMA_V3);
        this.version(4).stores(TRAINING_SCHEMA_V4);
        this.version(5).stores(TRAINING_SCHEMA_V5);
      }
    }
    const previous = new V5Db();
    await previous
      .table('bodyEntries')
      .put({ id: 'historic', measuredOn: '2026-10-01', weightKg: 80 });
    previous.close();

    const migrated = new TrainingDb(name, options);
    await migrated.open();
    expect(migrated.verno).toBe(6);
    expect(await migrated.bodyEntries.get('historic')).toMatchObject({
      measuredOn: '2026-10-01',
      weightKg: 80,
    });
    expect(await migrated.physicalAssessments.count()).toBe(0);
    expect(await migrated.assessmentDocuments.count()).toBe(0);
    migrated.close();
  });

  it('keeps the data of a version 1 database when a later version is opened', async () => {
    const factory = new FakeIDBFactory();
    const name = 'uniover-training-migracao';
    const options = { indexedDB: factory, ...FAKE };

    // O aparelho abre o app na versão 1 e grava dados.
    const v1 = new TrainingDb(name, options);
    await v1.exercises.bulkPut([
      localExercise('a', { name: 'Supino reto', primaryMuscles: ['chest'] }),
      localExercise('b', { name: 'Agachamento', primaryMuscles: ['quadriceps'], deleted: true }),
    ]);
    await v1.meta.put({ key: 'seen', value: true });
    await v1.syncState.put({ resource: 'exercises', cursor: 'c1', lastPullAt: 1234 });
    v1.close();

    // Uma tarefa futura acrescenta `version(2)` abaixo do bloco da versão 1, que não é editado.
    class NextDb extends Dexie {
      constructor() {
        super(name, options);
        this.version(1).stores(TRAINING_SCHEMA_V1);
        this.version(2).stores({ routines: 'id, name' });
      }
    }
    const next = new NextDb();
    await next.open();

    expect(next.verno).toBe(2);
    const exercises = await next.table('exercises').orderBy('id').toArray();
    expect(exercises.map((row: { id: string }) => row.id)).toEqual(['a', 'b']);
    expect(exercises[0]).toMatchObject({ name: 'Supino reto', primaryMuscles: ['chest'] });
    expect(exercises[1]).toMatchObject({ name: 'Agachamento', deletedAt: expect.any(Number) });
    expect(await next.table('meta').get('seen')).toEqual({ key: 'seen', value: true });
    expect(await next.table('syncState').get('exercises')).toEqual({
      resource: 'exercises',
      cursor: 'c1',
      lastPullAt: 1234,
    });
    // O índice antigo continua funcionando depois da migração.
    expect(await next.table('exercises').where('equipment').equals('barbell').count()).toBe(2);
    expect(await next.table('routines').count()).toBe(0);
    next.close();
  });
});
