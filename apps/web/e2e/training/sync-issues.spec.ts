import { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { TrainingServer } from './support/training-server';
import { openTraining, startTraining, chooseMuscle, expectSynced } from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Cria um exercício próprio enquanto o servidor recusa a escrita (422): o item da fila fica `failed`. */
async function createRefused(page: Page, server: TrainingServer) {
  server.failNext({
    method: 'PUT',
    path: /^exercises\//,
    status: 422,
    problem: 'client-clock-ahead',
    times: 1,
  });
  await openTraining(page, '/treino/exercicios/novo');
  await page.getByLabel('Nome').fill('Remada na máquina articulada');
  await chooseMuscle(page, 'Meio das costas');
  await page.getByRole('button', { name: 'Salvar Exercício' }).click();
  await expect(page.getByText('1 com erro')).toBeVisible();
}

test.describe('alterações que o servidor recusou', () => {
  test('o item aparece nas pendências com o motivo, e "Tentar de Novo" o reenvia', async ({
    page,
    context,
  }) => {
    const server = await startTraining(context, page);
    await createRefused(page, server);
    expect(server.writes('exercises')).toBe(0);

    await page.locator('.training-header .status').click();
    const sheet = page.getByRole('dialog', { name: 'Alterações com Erro' });
    await expect(sheet).toContainText('Exercício');
    await expect(sheet).toContainText('“Remada na máquina articulada”');
    await expect(sheet).toContainText('relógio');

    await sheet.getByRole('button', { name: /Tentar de novo/ }).click();
    await expect.poll(() => server.writes('exercises')).toBe(1);
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText('1 com erro')).toHaveCount(0);
    await expectSynced(page);
  });

  test('o item recusado não some sozinho, nem ao recarregar', async ({ page, context }) => {
    const server = await startTraining(context, page);
    await createRefused(page, server);
    await page.goto('/treino/exercicios');
    await expect(page.locator('app-training-page')).toBeVisible();
    await expect(page.getByText('1 com erro')).toBeVisible();
    expect(server.writes('exercises')).toBe(0);
  });

  test('descartar pede confirmação, e só a confirmação tira o item da fila', async ({
    page,
    context,
  }) => {
    const server = await startTraining(context, page);
    await createRefused(page, server);
    await page.locator('.training-header .status').click();
    const sheet = page.getByRole('dialog', { name: 'Alterações com Erro' });

    await sheet.getByRole('button', { name: /^Descartar/ }).click();
    await expect(sheet.getByText('Descartar esta alteração?')).toBeVisible();
    await sheet.getByRole('button', { name: 'Manter' }).click();
    await expect(sheet.getByText('Descartar esta alteração?')).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: /Tentar de novo/ })).toBeVisible();

    await sheet.getByRole('button', { name: /^Descartar/ }).click();
    await sheet
      .locator('.confirm')
      .getByRole('button', { name: /^Descartar/ })
      .click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText('1 com erro')).toHaveCount(0);
    expect(server.writes('exercises')).toBe(0);
  });
});
