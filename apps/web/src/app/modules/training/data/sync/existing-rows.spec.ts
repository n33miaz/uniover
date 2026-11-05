import { TestBed } from '@angular/core/testing';
import { IDBObjectStore } from 'fake-indexeddb';
import { CatalogRepository } from '../catalog/catalog-repository';
import { TRAINING_DB } from '../training-db';
import { RANGE_READ_MAX_ROWS, existingRowsById } from './existing-rows';
import { localExercise, setupTraining } from './training-test-kit';

/**
 * O custo do IndexedDB é por requisição (no WebKit do Playwright, ~15 ms cada: 500 `get` levam 7,6 s, um `getAll` das mesmas
 * 500 linhas 18 ms). O tempo de um teste com banco falso não prova nada; o que vale aqui é o número de requisições, que é
 * determinístico: ler as linhas existentes de uma página nunca pode custar uma requisição por linha.
 */
const ids = (count: number) =>
  Array.from({ length: count }, (_, n) => `row-${String(n).padStart(5, '0')}`);

const rows = (count: number) => ids(count).map((id) => localExercise(id));

function requests() {
  return {
    get: vi.spyOn(IDBObjectStore.prototype, 'get'),
    getAll: vi.spyOn(IDBObjectStore.prototype, 'getAll'),
    put: vi.spyOn(IDBObjectStore.prototype, 'put'),
    count: vi.spyOn(IDBObjectStore.prototype, 'count'),
  };
}

describe('existingRowsById', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads nothing but the count when the table is empty (first pull of a new device)', async () => {
    setupTraining();
    const db = TestBed.inject(TRAINING_DB);
    const spy = requests();

    const found = await existingRowsById(db.exercises, rows(500));

    expect(found.size).toBe(0);
    expect(spy.get).not.toHaveBeenCalled();
    expect(spy.getAll).not.toHaveBeenCalled();
    expect(spy.count).toHaveBeenCalledTimes(1);
  });

  it('reads the key range of the page in one request, whatever the page size', async () => {
    setupTraining();
    const db = TestBed.inject(TRAINING_DB);
    await db.exercises.bulkPut(rows(500));
    const spy = requests();

    const found = await existingRowsById(db.exercises, [
      localExercise('row-00007'),
      localExercise('row-00400'),
      localExercise('row-00123'),
      localExercise('not-there'),
    ]);

    expect([...found.keys()].sort()).toEqual(['row-00007', 'row-00123', 'row-00400']);
    expect(spy.get).not.toHaveBeenCalled();
    expect(spy.getAll.mock.calls.length + spy.count.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('falls back to a read by key when the table is too big to read a range from', async () => {
    setupTraining();
    const db = TestBed.inject(TRAINING_DB);
    await db.exercises.bulkPut(rows(RANGE_READ_MAX_ROWS + 1));
    const spy = requests();

    const found = await existingRowsById(db.exercises, [
      localExercise('row-00010'),
      localExercise('row-02000'),
    ]);

    expect([...found.keys()].sort()).toEqual(['row-00010', 'row-02000']);
    expect(spy.get).toHaveBeenCalledTimes(2);
    expect(spy.getAll).not.toHaveBeenCalled();
  });

  it('is what makes merging a 500-row catalog cost one write per row and no reads', async () => {
    setupTraining();
    const repository = TestBed.inject(CatalogRepository);
    const spy = requests();

    await repository.applyRemote(rows(500));
    expect(spy.get).not.toHaveBeenCalled();
    expect(spy.getAll).not.toHaveBeenCalled();
    expect(spy.put).toHaveBeenCalledTimes(500);

    // Segunda passada com as 500 linhas já no aparelho: a leitura é uma só, não 500.
    spy.put.mockClear();
    await repository.applyRemote(rows(500));
    expect(spy.get).not.toHaveBeenCalled();
    expect(spy.getAll.mock.calls.length).toBeLessThanOrEqual(1);
    expect(spy.put).toHaveBeenCalledTimes(500);
  });
});
