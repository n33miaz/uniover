import { join } from 'node:path';
import { expect, screenshot, test } from '../fixtures';
import type { Page, TestInfo } from '@playwright/test';
import {
  expectSynced,
  openTraining,
  startTraining,
  trainingDbName,
} from './support/training-pages';

test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

test('o diário usa a volta única do cabeçalho', async ({ page, context }) => {
  await startTraining(context, page);
  await openTraining(page, '/treino/alimentacao');

  const back = page.locator('app-page-top-bar .back');
  await expect(back).toHaveCount(1);
  await expect(page.locator('app-food-diary-page .back')).toHaveCount(0);
  await back.click();
  await expect(page).toHaveURL(/\/treino\/corpo$/);
});

test('os botões do diário voltam e avançam um dia', async ({ page, context }) => {
  await startTraining(context, page);
  await openTraining(page, '/treino/alimentacao');

  const day = page.locator('#diary-day');
  const initialDay = await day.inputValue();
  const previousDay = new Date(`${initialDay}T00:00:00Z`);
  previousDay.setUTCDate(previousDay.getUTCDate() - 1);

  await page.getByRole('button', { name: 'Dia anterior', exact: true }).click();
  await expect(day).toHaveValue(previousDay.toISOString().slice(0, 10));

  await page.getByRole('button', { name: 'Dia seguinte', exact: true }).click();
  await expect(day).toHaveValue(initialDay);
});

test('o diário só mostra o estado vazio depois de ler os lançamentos do dia', async ({
  page,
  context,
}) => {
  await startTraining(context, page);

  let markReadPending!: () => void;
  const readPending = new Promise<void>((resolve) => (markReadPending = resolve));
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
  await page.exposeFunction('waitForDiaryDayRead', () => {
    markReadPending();
    return readGate;
  });
  await page.addInitScript((dbName) => {
    const browser = window as Window & {
      waitForDiaryDayRead: () => Promise<void>;
    };
    const original = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess')!;
    Object.defineProperty(IDBRequest.prototype, 'onsuccess', {
      ...original,
      set(this: IDBRequest, handler: IDBRequest['onsuccess']) {
        const source = this.source;
        // Só a entrega do resultado da consulta por dia fica pendente. O banco abre e os outros pedidos seguem.
        if (
          handler &&
          source instanceof IDBIndex &&
          source.name === 'eatenOn' &&
          source.objectStore.name === 'meals' &&
          source.objectStore.transaction.db.name === dbName
        ) {
          original.set!.call(this, async (event: Event) => {
            await browser.waitForDiaryDayRead();
            handler.call(this, event);
          });
        } else {
          original.set!.call(this, handler);
        }
      },
    });
  }, trainingDbName());

  const diary = page.locator('app-food-diary-page');
  const loading = diary.getByRole('status').filter({ hasText: /^Carregando lançamentos…$/ });
  const empty = diary.getByRole('heading', { name: 'Nada Registrado Neste Dia' });
  try {
    await openTraining(page, '/treino/alimentacao');
    await readPending;
    await expect(loading).toBeVisible();
    await expect(empty).toBeHidden();
  } finally {
    releaseRead();
  }
  await expect(empty).toBeVisible();
  await expect(loading).toBeHidden();
});

// O envio pendente e a passada de atualização passam dos 5 s de uma verificação comum quando a máquina está ocupada.
const SYNC_WAIT = { timeout: 25_000 };

const SHOTS = process.env['TRAINING_SHOTS_DIR'] ?? 'test-results/training-food-diary';

const sampleOffFood = {
  id: '019a3a22-0000-7000-8000-000000000001',
  source: 'off',
  name: 'Banana de demonstração',
  brand: null,
  barcode: null,
  kcalPer100g: 89,
  proteinPer100g: 1.1,
  carbsPer100g: 22.8,
  fatPer100g: 0.3,
  defaultPortionGrams: 100,
  attribution: 'Open Food Facts, ODbL',
  updatedAt: '2026-10-22T12:00:00.000Z',
  clientUpdatedAt: '2026-10-22T12:00:00.000Z',
  deleted: false,
};

async function takeShot(page: Page, info: TestInfo, scheme: string, state: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await screenshot(page, join(SHOTS, `${state}-${scheme}-${info.project.name}.png`), {
    fullPage: true,
  });
}

/**
 * Muda o dia do diário. O WebKit dispara mais um `change` quando o campo de data perde o foco; o diário zera o
 * formulário a cada `change`, então o foco sai agora, e não no próximo toque (onde apagaria uma edição já começada).
 */
async function setDay(page: Page, value: string): Promise<void> {
  const day = page.locator('#diary-day');
  await day.fill(value);
  await day.dispatchEvent('change');
  await day.blur();
}

async function useOffFixture(page: Page, foods = [sampleOffFood]): Promise<() => string[]> {
  const queries: string[] = [];
  await page.route('**/api/v1/training/foods/off/search**', (route) => {
    queries.push(new URL(route.request().url()).searchParams.get('q') ?? '');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(foods),
    });
  });
  return () => queries;
}

test('a busca sem resultados termina sem mostrar aviso de erro', async ({ page, context }) => {
  await startTraining(context, page);
  const offSearchQueries = await useOffFixture(page, []);
  await openTraining(page, '/treino/alimentacao');

  const query = 'alimento inexistente de demonstração';
  const searchButton = page.getByRole('button', { name: 'Buscar', exact: true });
  await page.getByRole('searchbox', { name: 'Buscar alimento' }).fill(query);
  await searchButton.click();

  await expect.poll(offSearchQueries).toContain(query);
  await expect(searchButton).toBeEnabled();
  await expect(page.getByRole('list', { name: 'Resultados de alimentos' })).toBeHidden();
  await expect(page.locator('.search-field').getByRole('status')).toBeHidden();
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`diário alimentar, tema ${scheme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    });

    test(`busca, registra, edita, apaga, troca o dia e continua offline (${scheme})`, async ({
      page,
      context,
      cspViolations,
    }, info) => {
      // Fluxo longo (cerca de 50 passos, com capturas de tela): o prazo de 30 s é para um teste curto.
      test.slow();
      const server = await startTraining(context, page);
      expect(cspViolations).toEqual([]);
      const offSearchQueries = await useOffFixture(page);
      await openTraining(page, '/treino/alimentacao');
      expect(cspViolations).toEqual([]);
      await expect(page.getByRole('heading', { name: 'Diário Alimentar' })).toBeVisible();
      await expect(page.getByText('Nada Registrado Neste Dia')).toBeVisible();

      // Lançamento livre aceita zeros reais; valores não são inferidos.
      await page.getByRole('button', { name: 'Lançamento Livre' }).click();
      await page.getByLabel('Descrição do lançamento').fill('Registro de demonstração');
      await page.locator('#free-kcal').fill('0');
      await page.locator('#free-protein').fill('0');
      await page.locator('#free-carbs').fill('0');
      await page.locator('#free-fat').fill('0');
      await page.getByRole('button', { name: 'Registrar Refeição' }).click();
      await expect(page.locator('.entry-main strong')).toHaveText(['Registro de demonstração']);
      expect(cspViolations).toEqual([]);
      // A faixa "Sincronizar Agora" aparece enquanto o envio está pendente e empurra a tela: quem toca nesse meio tempo
      // erra o alvo. Cada passo espera o aparelho voltar a "em dia" antes do toque seguinte.
      await expectSynced(page, SYNC_WAIT);

      const day = page.locator('#diary-day');
      const today = await day.inputValue();
      const yesterday = await page.evaluate((value) => {
        const date = new Date(`${value}T12:00:00`);
        date.setDate(date.getDate() - 1);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      }, today);
      await setDay(page, yesterday);
      await expect(page.getByText('Nada Registrado Neste Dia')).toBeVisible();
      await setDay(page, today);
      await expect(page.locator('.entry-main strong')).toHaveText(['Registro de demonstração']);
      await expect(page.getByRole('status', { name: 'Carregando lançamentos…' })).toBeHidden();

      await page.getByRole('button', { name: 'Editar Registro de demonstração' }).click();
      await page.getByLabel('Descrição do lançamento').fill('Registro revisado');
      await page.getByRole('button', { name: 'Salvar Alterações' }).click();
      await expect(page.locator('.entry-main strong')).toHaveText(['Registro revisado']);
      await expectSynced(page, SYNC_WAIT);
      // O vermelho de apagar vem do tema (o mesmo do resto do app), não de uma cor fixa que ignora o escuro.
      const remove = page.getByRole('button', { name: 'Apagar Registro revisado' });
      const themed = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--a-bad-ink)';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect(remove).toHaveCSS('color', themed);
      expect(themed).not.toBe('rgb(163, 41, 41)');
      await remove.click();
      await page.getByRole('button', { name: 'Confirmar' }).click();
      await expect(page.getByText('Nada Registrado Neste Dia')).toBeVisible();
      expect(cspViolations).toEqual([]);
      await expectSynced(page, SYNC_WAIT);

      // Alimento próprio fica disponível na busca local mesmo sem consultar o catálogo externo.
      await page.locator('.own-food summary').click();
      await page.locator('#own-name').fill('Aveia de demonstração');
      await page.locator('#own-kcal').fill('389');
      await page.locator('#own-protein').fill('16.9');
      await page.locator('#own-carbs').fill('66.3');
      await page.locator('#own-fat').fill('6.9');
      await page.getByRole('button', { name: 'Salvar Alimento' }).click();
      await expect(page.locator('.selected-food strong')).toHaveText('Aveia de demonstração');
      await page.getByRole('button', { name: 'Registrar Refeição' }).click();
      await expect(page.locator('.entry-main strong')).toHaveText(['Aveia de demonstração']);
      await expectSynced(page, SYNC_WAIT);

      // Resultado do catálogo externo mantém a atribuição junto ao alimento.
      const search = page.getByRole('searchbox', { name: 'Buscar alimento' });
      await search.fill('banana');
      await expect(search).toHaveValue('banana');
      await page.getByRole('button', { name: 'Buscar' }).click();
      await expect.poll(() => offSearchQueries()).toContain('banana');
      const banana = page.getByRole('button', { name: /Banana de demonstração/ });
      await expect(banana).toBeVisible();
      await expect(page.getByText('Open Food Facts, ODbL')).toBeVisible();
      await banana.click();
      await page.getByLabel('Quantidade em gramas').fill('120');
      await page.getByRole('button', { name: 'Registrar Refeição' }).click();
      await expect(page.locator('.entry-main strong')).toHaveText([
        'Aveia de demonstração',
        'Banana de demonstração',
      ]);
      await expectSynced(page, SYNC_WAIT);

      // Sem rede, a cópia local continua pesquisável e o registro fica no aparelho.
      server.offline = true;
      await context.setOffline(true);
      await search.fill('aveia');
      const localOats = page.locator('.food-results .food-result').filter({
        hasText: 'Aveia de demonstração',
      });
      await expect(localOats).toBeVisible();
      await page.getByRole('button', { name: 'Buscar' }).click();
      await expect(
        page.getByText(/Sem conexão\. Mostrando alimentos salvos neste aparelho/),
      ).toBeVisible();
      await expect(localOats).toBeVisible();
      await localOats.click();
      await page.getByLabel('Quantidade em gramas').fill('50');
      await page.getByRole('button', { name: 'Registrar Refeição' }).click();
      await expect(page.locator('.entry-main strong')).toHaveText([
        'Aveia de demonstração',
        'Banana de demonstração',
        'Aveia de demonstração',
      ]);
      await expect(page.getByText('Refeição registrada neste aparelho.')).toBeVisible();
      await expect(page.getByRole('status', { name: 'Carregando lançamentos…' })).toBeHidden();
      await takeShot(page, info, scheme, 'filled-offline');
    });
  });
}

test('o diário mostra um aviso quando a busca remota falha', async ({ page, context }) => {
  await startTraining(context, page);
  const searchRoute = '**/api/v1/training/foods/off/search**';
  await page.route(searchRoute, (route) => route.fulfill({ status: 500 }));
  await openTraining(page, '/treino/alimentacao');

  const searchButton = page.getByRole('button', { name: 'Buscar', exact: true });
  await page.getByRole('searchbox', { name: 'Buscar alimento' }).fill('banana');
  const [response] = await Promise.all([page.waitForResponse(searchRoute), searchButton.click()]);

  expect(response.status()).toBe(500);
  await expect(searchButton).toBeEnabled();
  const notice = page.locator('.search-field').getByRole('status');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(
    'Não foi possível consultar o catálogo externo. Os alimentos locais continuam disponíveis.',
  );
});
