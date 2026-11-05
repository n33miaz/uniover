import { TestBed } from '@angular/core/testing';
import { IDBIndex, IDBObjectStore } from 'fake-indexeddb';
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
    // Varredura de tabela: nenhum caminho de leitura do merge pode abrir cursor, nem no armazém nem em índice.
    openCursor: vi.spyOn(IDBObjectStore.prototype, 'openCursor'),
    openKeyCursor: vi.spyOn(IDBObjectStore.prototype, 'openKeyCursor'),
    indexGetAll: vi.spyOn(IDBIndex.prototype, 'getAll'),
    indexOpenCursor: vi.spyOn(IDBIndex.prototype, 'openCursor'),
  };
}

type Requests = ReturnType<typeof requests>;

/** Nenhuma leitura do banco foi uma varredura: sem cursor, sem leitura de índice. */
function expectNoScan(spy: Requests): void {
  expect(spy.openCursor).not.toHaveBeenCalled();
  expect(spy.openKeyCursor).not.toHaveBeenCalled();
  expect(spy.indexGetAll).not.toHaveBeenCalled();
  expect(spy.indexOpenCursor).not.toHaveBeenCalled();
}

/** A faixa de chaves pedida na leitura em lote: fechada nas duas pontas, do menor ao maior id da página. */
function expectRange(spy: Requests, lower: string, upper: string): void {
  expect(spy.getAll).toHaveBeenCalledTimes(1);
  // O Dexie pede a leitura em lote com opções (`{ query, count?, direction }`), e a faixa vai em `query`.
  const { query: range } = spy.getAll.mock.calls[0]![0] as unknown as { query: IDBKeyRange };
  expect(range.lower).toBe(lower);
  expect(range.upper).toBe(upper);
  expect(range.lowerOpen).toBe(false);
  expect(range.upperOpen).toBe(false);
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
    expectNoScan(spy);
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
    expect(spy.count).toHaveBeenCalledTimes(1);
    // O menor id da página é "not-there" (ordem das chaves), o maior "row-00400": a faixa é essa, fechada.
    expectRange(spy, 'not-there', 'row-00400');
    expectNoScan(spy);
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
    expectNoScan(spy);
  });

  it(
    'is what makes merging a 500-row catalog cost one write per row and no reads',
    { timeout: 20_000 },
    async () => {
      setupTraining();
      const repository = TestBed.inject(CatalogRepository);
      const spy = requests();

      await repository.applyRemote(rows(500));
      expect(spy.get).not.toHaveBeenCalled();
      expect(spy.getAll).not.toHaveBeenCalled();
      expect(spy.put).toHaveBeenCalledTimes(500);
      expectNoScan(spy);

      // Segunda passada com as 500 linhas já no aparelho: a leitura é uma só, não 500.
      for (const request of Object.values(spy)) request.mockClear();
      await repository.applyRemote(rows(500));
      expect(spy.get).not.toHaveBeenCalled();
      expectRange(spy, 'row-00000', 'row-00499');
      expect(spy.count).toHaveBeenCalledTimes(1);
      expect(spy.put).toHaveBeenCalledTimes(500);
      expectNoScan(spy);
    },
  );
});
