import { Page } from '@playwright/test';
import { expect, test, waitForServiceWorkerControl } from '../fixtures';
import {
  openTraining,
  startTraining,
  trainingDbName,
  waitForCatalog,
  chooseMuscle,
} from './support/training-pages';

const goOffline = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('offline')));
const goOnline = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('online')));

test.describe('exercício próprio criado sem rede', () => {
  // A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
  test.use({ serviceWorkers: 'block' });

  test('aparece na lista na hora, e a escrita chega ao servidor uma vez quando a rede volta', async ({
    page,
    context,
  }) => {
    const server = await startTraining(context, page);
    await openTraining(page, '/treino/exercicios/novo');
    server.offline = true;
    await goOffline(page);

    await page.getByLabel('Nome').fill('Remada na máquina articulada');
    await chooseMuscle(page, 'Meio das costas');
    await page.getByRole('button', { name: 'Salvar exercício' }).click();
    await expect(page.getByRole('heading', { name: 'Remada na máquina articulada' })).toBeVisible();

    // Recarrega ainda sem rede: o exercício vem do aparelho, com a marca de próprio.
    await page.goto('/treino/exercicios');
    await expect(page.locator('app-training-page')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Buscar exercício' }).fill('articulada');
    await expect(page.locator('.list .name')).toHaveText(['Remada na máquina articulada']);
    await expect(page.locator('.list .ui-chip', { hasText: 'própria' })).toBeVisible();
    await expect(page.getByText('1 ainda não sincronizado')).toBeVisible();
    expect(server.writes('exercises')).toBe(0);

    server.offline = false;
    await goOnline(page);
    await expect.poll(() => server.writes('exercises')).toBe(1);
    await expect(page.getByText(/sincronizado às \d{2}:\d{2}/)).toBeVisible();
    await expect(page.getByText('ainda não sincronizado')).toHaveCount(0);

    const puts = server.hits.filter(
      (hit) => hit.method === 'PUT' && hit.path.startsWith('exercises/'),
    );
    expect(puts.filter((hit) => hit.outcome === 'executed')).toHaveLength(1);
    // Todas as tentativas (as que caíram sem rede e a que passou) levam a mesma chave de idempotência.
    expect(new Set(puts.map((hit) => hit.key)).size).toBe(1);
    expect(server.rows('exercises').filter((row) => row['source'] === 'own')).toHaveLength(1);
  });
});

test.describe('sem rede de verdade, com o service worker', () => {
  test.use({ serviceWorkers: 'allow' });

  // Aparelho que já teve uma sessão: a dica da última conta (que o app grava ao entrar) diz qual banco local abrir sem
  // esperar o `/me`. Sem ela e sem rede nenhum banco de conta seria aberto (ver `accounts.spec.ts`).
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      localStorage.setItem('uniover.account-id', 'u1');
    });
  });

  // Grava linhas direto no banco local do Treino, como o puxador faria com o que o servidor entrega.
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

  const exercise = (id: string, name: string, muscle: string) => ({
    id,
    slug: id,
    source: 'free_exercise_db',
    sourceRef: id,
    name,
    nameKey: name.toLowerCase(),
    instructions: ['Faça o movimento.'],
    primaryMuscles: [muscle],
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
  });

  test('recarregar sem rede mantém o catálogo, as rotinas e o que foi criado', async ({
    page,
    context,
  }) => {
    await page.goto('/treino/exercicios');
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
    await putRows(page, 'exercises', [
      exercise('e1', 'Supino reto', 'chest'),
      exercise('e2', 'Agachamento livre', 'quadriceps'),
    ]);
    await putRows(page, 'routines', [
      {
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
      },
    ]);

    await context.setOffline(true);
    await page.reload();
    await waitForCatalog(page);
    await expect(page.locator('.list .name')).toHaveText(['Agachamento livre', 'Supino reto']);
    await expect(page.getByText('Sem rede: usando o que está no aparelho')).toBeVisible();

    // Criar sem rede, de ponta a ponta.
    await page.getByRole('link', { name: 'Novo exercício' }).click();
    await page.getByLabel('Nome').fill('Remada articulada');
    await chooseMuscle(page, 'Meio das costas');
    await page.getByRole('button', { name: 'Salvar exercício' }).click();
    await expect(page.getByRole('heading', { name: 'Remada articulada' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Remada articulada' })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Abas do módulo' })
      .getByRole('link', { name: 'Exercício' })
      .click();
    await expect(page.locator('.list .name')).toHaveText([
      'Agachamento livre',
      'Remada articulada',
      'Supino reto',
    ]);
    await page
      .getByRole('navigation', { name: 'Catálogo ou rotinas' })
      .getByRole('link', { name: 'Rotinas' })
      .click();
    await expect(page.getByText('Treino A')).toBeVisible();
    await expect(page.getByText('1 ainda não sincronizado')).toBeVisible();
    await context.setOffline(false);
  });
});
