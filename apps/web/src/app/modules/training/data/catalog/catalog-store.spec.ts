import { TestBed } from '@angular/core/testing';
import { localExercise, setupTraining } from '../sync/training-test-kit';
import { CatalogRepository } from './catalog-repository';
import { CatalogStore, READ_TIMEOUT_MS } from './catalog-store';
import { CatalogWriter } from './catalog-writer';

/** Os efeitos só rodam quando o Angular os executa; o teste faz isso a cada tentativa. */
const eventually = (check: () => void) =>
  vi.waitFor(() => {
    TestBed.tick();
    check();
  });

async function setup() {
  const t = setupTraining();
  t.pause();
  const repository = TestBed.inject(CatalogRepository);
  await repository.applyRemote([
    localExercise('a', { name: 'Supino reto', primaryMuscles: ['chest'], equipment: 'barbell' }),
    localExercise('b', {
      name: 'Agachamento livre',
      primaryMuscles: ['quadriceps'],
      equipment: 'barbell',
    }),
    localExercise('c', { name: 'Rosca direta', primaryMuscles: ['biceps'], equipment: 'dumbbell' }),
  ]);
  return {
    ...t,
    repository,
    store: TestBed.inject(CatalogStore),
    writer: TestBed.inject(CatalogWriter),
  };
}

describe('CatalogStore', () => {
  it('reads the local catalog on start and flags when it is ready', async () => {
    const { store } = await setup();
    expect(store.ready()).toBe(false);

    await eventually(() => expect(store.ready()).toBe(true));

    expect(store.results().map((row) => row.name)).toEqual([
      'Agachamento livre',
      'Rosca direta',
      'Supino reto',
    ]);
    expect(store.total()).toBe(3);
  });

  it('rereads when the filters change and keeps the total of the whole catalog', async () => {
    const { store } = await setup();
    await eventually(() => expect(store.ready()).toBe(true));

    store.setQuery({ text: 'supino' });
    await eventually(() => expect(store.results().map((row) => row.name)).toEqual(['Supino reto']));
    expect(store.total()).toBe(3);

    store.setQuery({ equipment: 'dumbbell' });
    await eventually(() => expect(store.results()).toEqual([]));
    expect(store.query()).toEqual({ text: 'supino', equipment: 'dumbbell' });

    store.clearQuery();
    await eventually(() => expect(store.results()).toHaveLength(3));
  });

  it('shows a new exercise as soon as it is saved on the device', async () => {
    const { store, writer } = await setup();
    await eventually(() => expect(store.ready()).toBe(true));

    await writer.saveCustomExercise({
      name: 'Remada na polia',
      primaryMuscles: ['middle_back'],
      equipment: 'cable',
      recordType: 'weight_reps',
    });

    await eventually(() =>
      expect(store.results().map((row) => row.name)).toContain('Remada na polia'),
    );
    expect(store.total()).toBe(4);
  });

  it('shows what a pull brings, because merging bumps the revision', async () => {
    const { store, repository } = await setup();
    await eventually(() => expect(store.ready()).toBe(true));

    await repository.applyRemote([
      localExercise('d', { name: 'Elevação pélvica', primaryMuscles: ['glutes'] }),
    ]);

    await eventually(() => expect(store.total()).toBe(4));
  });

  it('keeps only the answer to the latest filter when reads finish out of order', async () => {
    const { store, repository } = await setup();
    await eventually(() => expect(store.ready()).toBe(true));

    // A primeira leitura demora; a segunda termina antes e é a que vale.
    const real = repository.search.bind(repository);
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(repository, 'search').mockImplementationOnce(async (query) => {
      await slow;
      return real(query);
    });

    store.setQuery({ text: 'supino' });
    TestBed.tick();
    store.setQuery({ text: 'rosca' });
    await eventually(() =>
      expect(store.results().map((row) => row.name)).toEqual(['Rosca direta']),
    );

    release();
    await slow;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.results().map((row) => row.name)).toEqual(['Rosca direta']);
  });

  it('leaves the skeleton with the failed flag when the local database fails, and recovers on retry', async () => {
    const { store, repository } = await setup();
    const real = repository.search.bind(repository);
    vi.spyOn(repository, 'search').mockRejectedValueOnce(new Error('indexeddb unavailable'));

    await eventually(() => expect(store.ready()).toBe(true));
    expect(store.results()).toEqual([]);
    expect(store.total()).toBe(0);
    expect(store.failed()).toBe(true);

    vi.spyOn(repository, 'search').mockImplementation(real);
    store.setQuery({ text: 'supino' });
    await eventually(() => expect(store.results().map((row) => row.name)).toEqual(['Supino reto']));
    // A falha não gravou o total: a releitura o conta de novo.
    expect(store.total()).toBe(3);
    expect(store.failed()).toBe(false);
  });

  it('turns a read that never answers into the failed state, and retry reads again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { store, repository } = await setup();
      const real = repository.search.bind(repository);
      vi.spyOn(repository, 'search').mockImplementationOnce(
        () => new Promise<never>(() => undefined),
      );
      TestBed.tick();
      expect(store.ready()).toBe(false);

      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1);
      expect(store.ready()).toBe(true);
      expect(store.failed()).toBe(true);

      vi.spyOn(repository, 'search').mockImplementation(real);
      store.retry();
      await vi.waitFor(() => expect(store.failed()).toBe(false));
      expect(store.results()).toHaveLength(3);
      expect(store.total()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts the whole catalog once per write, not once per filter change', async () => {
    const { store, repository } = await setup();
    await eventually(() => expect(store.ready()).toBe(true));
    const count = vi.spyOn(repository, 'count');

    store.setQuery({ text: 'supino' });
    await eventually(() => expect(store.results()).toHaveLength(1));
    store.setQuery({ text: 'rosca' });
    await eventually(() =>
      expect(store.results().map((row) => row.name)).toEqual(['Rosca direta']),
    );
    expect(count).not.toHaveBeenCalled();

    await repository.applyRemote([localExercise('d', { name: 'Elevação pélvica' })]);
    await eventually(() => expect(store.total()).toBe(4));
    expect(count).toHaveBeenCalledTimes(1);
  });
});
