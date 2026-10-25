import { join } from 'node:path';
import { expect, screenshot, test } from '../fixtures';
import type { Page, TestInfo } from '@playwright/test';
import { expectSynced, openTraining, startTraining } from './support/training-pages';

test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

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

async function useOffFixture(page: Page): Promise<() => string[]> {
  const queries: string[] = [];
  await page.route('**/api/v1/training/foods/off/search**', (route) => {
    queries.push(new URL(route.request().url()).searchParams.get('q') ?? '');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([sampleOffFood]),
    });
  });
  return () => queries;
}

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
      await expect(page.getByRole('heading', { name: 'Diário alimentar' })).toBeVisible();
      await expect(page.getByText('Nada registrado neste dia')).toBeVisible();

      // Lançamento livre aceita zeros reais; valores não são inferidos.
      await page.getByRole('button', { name: 'Lançamento livre' }).click();
      await page.getByLabel('Descrição do lançamento').fill('Registro de demonstração');
      await page.locator('#free-kcal').fill('0');
      await page.locator('#free-protein').fill('0');
      await page.locator('#free-carbs').fill('0');
      await page.locator('#free-fat').fill('0');
      await page.getByRole('button', { name: 'Registrar refeição' }).click();
      await expect(page.locator('.entry-main strong')).toHaveText(['Registro de demonstração']);
      expect(cspViolations).toEqual([]);
      // A faixa "Sincronizar agora" aparece enquanto o envio está pendente e empurra a tela: quem toca nesse meio tempo
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
      await expect(page.getByText('Nada registrado neste dia')).toBeVisible();
      await setDay(page, today);
      await expect(page.locator('.entry-main strong')).toHaveText(['Registro de demonstração']);
      await expect(page.getByRole('status', { name: 'Carregando lançamentos…' })).toBeHidden();

      await page.getByRole('button', { name: 'Editar Registro de demonstração' }).click();
      await page.getByLabel('Descrição do lançamento').fill('Registro revisado');
      await page.getByRole('button', { name: 'Salvar alterações' }).click();
      await expect(page.locator('.entry-main strong')).toHaveText(['Registro revisado']);
      await expectSynced(page, SYNC_WAIT);
      await page.getByRole('button', { name: 'Apagar Registro revisado' }).click();
      await page.getByRole('button', { name: 'Confirmar' }).click();
      await expect(page.getByText('Nada registrado neste dia')).toBeVisible();
      expect(cspViolations).toEqual([]);
      await expectSynced(page, SYNC_WAIT);

      // Alimento próprio fica disponível na busca local mesmo sem consultar o catálogo externo.
      await page.locator('.own-food summary').click();
      await page.locator('#own-name').fill('Aveia de demonstração');
      await page.locator('#own-kcal').fill('389');
      await page.locator('#own-protein').fill('16.9');
      await page.locator('#own-carbs').fill('66.3');
      await page.locator('#own-fat').fill('6.9');
      await page.getByRole('button', { name: 'Salvar alimento' }).click();
      await expect(page.locator('.selected-food strong')).toHaveText('Aveia de demonstração');
      await page.getByRole('button', { name: 'Registrar refeição' }).click();
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
      await page.getByRole('button', { name: 'Registrar refeição' }).click();
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
      await page.getByRole('button', { name: 'Registrar refeição' }).click();
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
