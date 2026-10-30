import { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { TrainingServer } from './support/training-server';
import { openTraining, startTraining, chooseMuscle } from './support/training-pages';

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
  await expect(page.locator('app-page-top-bar .ring[data-state="failed"]')).toBeVisible();
}

async function openIssues(page: Page) {
  await page.locator('app-page-top-bar .ring').click();
  await page
    .getByRole('dialog', { name: 'Sincronização' })
    .getByRole('button', { name: 'Ver os Recusados' })
    .click();
}

test.describe('alterações que o servidor recusou', () => {
  test('o item aparece nas pendências com o motivo, e "Tentar de Novo" o reenvia', async ({
    page,
    context,
  }) => {
    const server = await startTraining(context, page);
    await createRefused(page, server);
    expect(server.writes('exercises')).toBe(0);

    await openIssues(page);
    const sheet = page.getByRole('dialog', { name: 'Alterações com Erro' });
    await expect(sheet).toContainText('Exercício');
    await expect(sheet).toContainText('“Remada na máquina articulada”');
    await expect(sheet).toContainText('relógio');

    await sheet.getByRole('button', { name: /Tentar de novo/ }).click();
    await expect.poll(() => server.writes('exercises')).toBe(1);
    await expect(sheet).toHaveCount(0);
    await expect(page.locator('.ring[data-state="failed"]')).toHaveCount(0);
  });

  test('o item recusado não some sozinho, nem ao recarregar', async ({ page, context }) => {
    const server = await startTraining(context, page);
    await createRefused(page, server);
    await page.goto('/treino/exercicios');
    await expect(page.locator('app-training-page')).toBeVisible();
    await expect(page.locator('app-page-top-bar .ring[data-state="failed"]')).toBeVisible();
    expect(server.writes('exercises')).toBe(0);
  });

  test('descartar pede confirmação, e só a confirmação tira o item da fila', async ({
    page,
    context,
  }) => {
    const server = await startTraining(context, page);
    await createRefused(page, server);
    await openIssues(page);
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
    await expect(page.locator('.ring[data-state="failed"]')).toHaveCount(0);
    expect(server.writes('exercises')).toBe(0);
  });
});

test('o anel nunca vira botão de sincronizar: em dia ele some, e o menu não traz problemas de sincronização', async ({
  page,
  context,
}) => {
  const server = await startTraining(context, page);
  await createRefused(page, server);
  await page.locator('app-page-top-bar .ring').click();
  const sheet = page.getByRole('dialog', { name: 'Sincronização' });
  await expect(sheet).toContainText('O servidor recusou alterações.');
  await expect(sheet.getByRole('button', { name: 'Tentar de Novo' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Fechar' }).click();
  // Sem ações de tela não há três pontos; o anel tem o próprio alvo de toque de 44 px ou mais.
  const box = (await page.locator('app-page-top-bar .ring').boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole('button', { name: 'Problemas de Sincronização' })).toHaveCount(0);
});
