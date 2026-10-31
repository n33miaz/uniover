import { Page } from '@playwright/test';
import { expect, test, waitForServiceWorkerControl } from '../fixtures';
import { openTraining, startTraining, trainingDbName } from './support/training-pages';

// Os dois quadros do supino reto com barra (o primeiro exercício das rotinas de teste).
const BENCH_POSES = ['/exercise-art/0042-relaxation.webp', '/exercise-art/0042-tension.webp'];

const cachedArt = (page: Page) =>
  page.evaluate(async () => {
    const cache = await caches.open('exercise-art');
    return (await cache.keys()).map((request) => new URL(request.url).pathname).sort();
  });

const goOffline = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('offline')));
const goOnline = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('online')));

test.describe('figuras do Treino guardadas para a academia', () => {
  // A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker. Sem ele em controle,
  // é a situação da primeira visita: nada interceptaria o `fetch` e guardaria a figura.
  test.use({ serviceWorkers: 'block' });

  test('na primeira visita, sem o service worker no controle, a página mesma guarda as figuras', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino');
    await expect.poll(() => cachedArt(page)).toEqual(expect.arrayContaining(BENCH_POSES));
  });

  test('a rede que cai no meio não deixa o aquecimento por feito: ao voltar, as figuras são buscadas de novo', async ({
    page,
    context,
  }) => {
    let down = true;
    let refused = 0;
    await page.route('**/exercise-art/**', (route) => {
      if (!down) return route.continue();
      refused += 1;
      return route.abort('internetdisconnected');
    });
    await startTraining(context, page);
    await openTraining(page, '/treino');
    await expect.poll(() => refused).toBeGreaterThan(0);
    expect(await cachedArt(page)).toEqual([]);

    down = false;
    await goOffline(page);
    await goOnline(page);
    await expect.poll(() => cachedArt(page)).toEqual(expect.arrayContaining(BENCH_POSES));
  });
});

test.describe('figuras do Treino sem rede, com o service worker', () => {
  test.use({ serviceWorkers: 'allow' });

  // Aparelho que já teve uma sessão: a dica da última conta diz qual banco local abrir sem esperar o `/me`.
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      localStorage.setItem('uniover.account-id', 'u1');
    });
  });

  async function putRows(page: Page, store: string, rows: Record<string, unknown>[]) {
    await page.evaluate(
      ({ store, rows, dbName }) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open(dbName);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction(store, 'readwrite');
            for (const row of rows) tx.objectStore(store).put(row);
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
      { store, rows, dbName: trainingDbName() },
    );
  }

  const bench = {
    id: 'e1',
    slug: 'supino-reto-com-barra',
    source: 'free_exercise_db',
    sourceRef: 'e1',
    name: 'Supino reto com barra',
    nameKey: 'supino reto com barra',
    instructions: ['Faça o movimento.'],
    primaryMuscles: ['chest'],
    secondaryMuscles: [],
    equipment: 'barbell',
    recordType: 'weight_reps',
    stepKg: null,
    stepClientUpdatedAt: null,
    level: null,
    category: null,
    mechanic: null,
    license: null,
    licenseAuthor: null,
    licenseUrl: null,
    reviewed: true,
    updatedAt: 1,
    clientUpdatedAt: 1,
    deletedAt: null,
  };

  const routine = {
    id: 'r1',
    name: 'Treino A',
    position: 0,
    active: true,
    note: '',
    items: [
      {
        id: 'i1',
        exerciseId: 'e1',
        position: 0,
        targetSets: 3,
        repMin: 8,
        repMax: 12,
        restSeconds: 90,
        supersetGroup: null,
        note: '',
      },
    ],
    updatedAt: 1,
    clientUpdatedAt: 1,
    deletedAt: null,
  };

  test('depois do primeiro uso com rede, a rotina mostra as figuras ao recarregar sem rede', async ({
    page,
    context,
  }) => {
    await page.goto('/treino');
    await waitForServiceWorkerControl(page);
    await expect(page.locator('app-training-page')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          async (name) => ((await indexedDB.databases()) ?? []).some((db) => db.name === name),
          trainingDbName(),
        ),
      )
      .toBe(true);
    await putRows(page, 'exercises', [bench]);
    await putRows(page, 'routines', [routine]);

    // Com rede, abrir o Treino aquece as figuras da rotina ativa.
    await page.reload();
    await expect(page.locator('app-training-page')).toBeVisible();
    await expect.poll(() => cachedArt(page)).toEqual(expect.arrayContaining(BENCH_POSES));

    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.locator('app-training-page')).toBeVisible();
      await page.getByRole('button', { name: 'Ver Rotina' }).click();
      const thumb = page.locator('.lines app-exercise-thumb img').first();
      await expect(thumb).toBeVisible();
      await expect
        .poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
        .toBeGreaterThan(0);
    } finally {
      await context.setOffline(false);
    }
  });
});
