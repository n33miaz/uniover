import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { type FoodDto, toLocalFood } from './food';
import { localFood, setupFoods } from './food-data-test-kit';

describe('Food response mapping', () => {
  it('maps OFF and TACO sources without inventing source references', () => {
    const base = {
      id: 'catalog-food',
      name: 'Alimento de catálogo',
      brand: null,
      kcalPer100g: 100,
      proteinPer100g: 5,
      carbsPer100g: 10,
      fatPer100g: 2,
      defaultPortionGrams: null,
      attribution: null,
      updatedAt: '2026-10-01T10:00:00.000Z',
      clientUpdatedAt: '2026-10-01T10:00:00.000Z',
      deleted: false,
    };

    expect(toLocalFood({ ...base, source: 'off', barcode: '78912345' } as FoodDto)).toMatchObject({
      source: 'off',
      sourceRef: null,
      barcode: '78912345',
    });
    expect(toLocalFood({ ...base, source: 'taco', barcode: null } as FoodDto)).toMatchObject({
      source: 'taco',
      sourceRef: null,
      barcode: null,
    });
  });

  it('rejects unrecognized catalog sources instead of treating them as OFF', () => {
    expect(() => toLocalFood({ id: 'unknown', source: 'vendor' } as FoodDto)).toThrow(
      'Unsupported food source',
    );
  });
});

describe('FoodRepository', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('rejects values outside the API contract before writing or queuing', async () => {
    const t = setupFoods();
    const valid = {
      name: 'Alimento de teste',
      kcalPer100g: 100,
      proteinPer100g: 5,
      carbsPer100g: 10,
      fatPer100g: 2,
    };

    expect(await t.repository.saveOwn({ ...valid, brand: 'b'.repeat(121) })).toEqual({
      status: 'invalid',
    });
    expect(await t.repository.saveOwn({ ...valid, defaultPortionGrams: 10000.01 })).toEqual({
      status: 'invalid',
    });
    expect(await t.repository.saveOwn({ ...valid, defaultPortionGrams: 12.345 })).toEqual({
      status: 'invalid',
    });
    expect(
      await t.repository.saveOwn({ ...valid, id: '00000000-0000-4000-8000-000000000001' }),
    ).toEqual({ status: 'invalid' });
    expect(await t.trainingDb.foods.count()).toBe(0);
    expect(await t.outbox()).toHaveLength(0);
  });

  it('searches local food names without accents and saves own foods once through the offline queue', async () => {
    const t = setupFoods();
    const repository = t.repository;
    const result = await repository.saveOwn({
      name: 'Pão de queijo',
      kcalPer100g: 350,
      proteinPer100g: 8,
      carbsPer100g: 40,
      fatPer100g: 16,
      defaultPortionGrams: 50,
    });
    expect(result.status).toBe('saved');
    expect((await repository.searchLocal('pao queijo')).map((food) => food.name)).toEqual([
      'Pão de queijo',
    ]);
    expect(await t.trainingDb.foods.count()).toBe(1);
    expect(await t.outbox()).toHaveLength(1);
    expect((await t.outbox())[0]).toMatchObject({
      method: 'PUT',
      module: 'training',
      url: `/api/v1/training/foods/${result.status === 'saved' ? result.food.id : ''}`,
      status: 'pending',
    });
  });

  it('deletes only a personal food by sending a queued tombstone', async () => {
    const t = setupFoods();
    const saved = await t.repository.saveOwn({
      name: 'Castanha',
      kcalPer100g: 600,
      proteinPer100g: 20,
      carbsPer100g: 20,
      fatPer100g: 50,
    });
    if (saved.status !== 'saved') throw new Error('Alimento não foi salvo.');

    expect((await t.repository.softDelete(saved.food.id)).status).toBe('saved');
    expect(await t.repository.searchLocal('castanha')).toEqual([]);
    expect((await t.trainingDb.foods.get(saved.food.id))?.deletedAt).not.toBeNull();
    const queued = await t.outbox();
    expect(queued).toHaveLength(2);
    expect(queued[1].body).toMatchObject({ deleted: true });
  });

  it('returns local results without a server request when offline', async () => {
    const t = setupFoods();
    await t.repository.applyRemote([localFood('offline-food')]);
    const original = navigator.onLine;
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    try {
      expect(await t.repository.searchOnline('iogurte')).toMatchObject({ status: 'offline' });
      expect(TestBed.inject(HttpTestingController).match(() => true)).toHaveLength(0);
    } finally {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: original });
    }
  });

  it('calls only the same-origin search endpoint and caches the returned catalog items', async () => {
    const t = setupFoods();
    const request = t.repository.searchOnline('Iogurte');
    const http = TestBed.inject(HttpTestingController);
    const call = await vi.waitFor(() =>
      http.expectOne((item) => item.url === '/api/v1/training/foods/off/search'),
    );
    expect(call.request.method).toBe('GET');
    expect(call.request.params.get('q')).toBe('Iogurte');
    call.flush([
      {
        id: 'remote-food',
        source: 'off',
        name: 'Iogurte natural',
        brand: null,
        barcode: '78912345',
        kcalPer100g: 60,
        proteinPer100g: 4,
        carbsPer100g: 5,
        fatPer100g: 2,
        defaultPortionGrams: 170,
        attribution: 'Open Food Facts, ODbL',
        updatedAt: '2026-10-01T10:00:00.000Z',
        clientUpdatedAt: '2026-10-01T10:00:00.000Z',
        deleted: false,
      },
    ]);
    expect(await request).toMatchObject({ status: 'ok', foods: [{ id: 'remote-food' }] });
    expect(await t.repository.searchLocal('iogurte')).toHaveLength(1);
  });

  it('surfaces rate limits and missing server configuration without retrying', async () => {
    const t = setupFoods();
    const http = TestBed.inject(HttpTestingController);
    const limited = t.repository.searchOnline('arroz');
    const limitedRequest = await vi.waitFor(() =>
      http.expectOne((request) => request.url === '/api/v1/training/foods/off/search'),
    );
    limitedRequest.flush(
      {},
      {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '17' },
      },
    );
    expect(await limited).toMatchObject({ status: 'rate-limited', retryAfterSeconds: 17 });

    const unavailable = t.repository.searchOnline('feijão');
    const configRequest = await vi.waitFor(() =>
      http.expectOne((request) => request.url === '/api/v1/training/foods/off/search'),
    );
    configRequest.flush(
      { type: 'https://errors.uniover.app/off-not-configured' },
      { status: 503, statusText: 'Service Unavailable' },
    );
    expect(await unavailable).toMatchObject({ status: 'not-configured' });
    expect(http.match('/api/v1/training/foods/off/search')).toHaveLength(0);
  });

  it('keeps the newest edit and deletion tombstone when remote rows merge', async () => {
    const t = setupFoods();
    await t.repository.saveOwn({
      name: 'Aveia',
      kcalPer100g: 380,
      proteinPer100g: 13,
      carbsPer100g: 67,
      fatPer100g: 7,
    });
    const own = (await t.trainingDb.foods.toArray())[0];
    await t.repository.applyRemote([
      localFood(own.id, {
        source: 'own',
        name: 'Aveia antiga',
        updatedAt: '2025-09-30T10:00:00Z',
        clientUpdatedAt: '2025-09-30T10:00:00Z',
      }),
    ]);
    expect((await t.trainingDb.foods.get(own.id))?.name).toBe('Aveia');

    const deleted = localFood(own.id, {
      source: 'own',
      deleted: true,
      updatedAt: '2026-10-02T10:00:00Z',
      clientUpdatedAt: '2026-10-02T10:00:00Z',
    });
    await t.repository.applyRemote([deleted]);
    expect(await t.repository.searchLocal('aveia')).toEqual([]);
    expect((await t.trainingDb.foods.get(own.id))?.deletedAt).not.toBeNull();
  });

  it('does not leak food records between account databases', async () => {
    const t = setupFoods();
    const other = t.trainingDbOf('outra-conta');
    await t.trainingDb.foods.put(localFood('shared-id', { name: 'Alimento pessoal' }));
    await other.foods.put(localFood('shared-id', { name: 'Alimento de outra conta' }));
    expect((await t.trainingDb.foods.get('shared-id'))?.name).toBe('Alimento pessoal');
    expect((await other.foods.get('shared-id'))?.name).toBe('Alimento de outra conta');
    expect(await t.outbox()).toHaveLength(0);
  });
});
