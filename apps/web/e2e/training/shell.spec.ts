import { expect, expectNoHorizontalScroll, test, waitForServiceWorkerControl } from '../fixtures';
import { openTraining, startTraining, waitForCatalog } from './support/training-pages';

test.describe('casca do Treino', () => {
  // A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
  test.use({ serviceWorkers: 'block' });

  test('as quatro abas levam a quatro telas, e a aba aberta fica marcada', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino');
    const tabs = page.getByRole('navigation', { name: 'Abas do módulo' });
    await expect(tabs.getByRole('link')).toHaveText(['Hoje', 'Exercícios', 'Progresso', 'Corpo']);
    await expect(tabs.getByRole('link', { name: 'Hoje' })).toHaveAttribute('aria-current', 'page');

    await tabs.getByRole('link', { name: 'Exercícios' }).click();
    await expect(page).toHaveURL(/\/treino\/exercicios$/);
    await expect(tabs.getByRole('link', { name: 'Exercícios' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await waitForCatalog(page);

    await tabs.getByRole('link', { name: 'Progresso' }).click();
    await expect(page).toHaveURL(/\/treino\/progresso$/);
    await expect(page.getByRole('heading', { name: 'Progresso' })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Progresso' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await tabs.getByRole('link', { name: 'Corpo' }).click();
    await expect(page).toHaveURL(/\/treino\/corpo$/);
    await expect(page.getByRole('heading', { name: 'Corpo' })).toBeVisible();

    await tabs.getByRole('link', { name: 'Hoje' }).click();
    await expect(page).toHaveURL(/\/treino$/);
  });

  test('o seletor Catálogo | Rotinas troca de tela sem sair da aba Exercícios', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    const choice = page.getByRole('navigation', { name: 'Catálogo ou rotinas' });
    await expect(choice.getByRole('link', { name: 'Catálogo' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await choice.getByRole('link', { name: 'Rotinas' }).click();
    await expect(page).toHaveURL(/\/treino\/rotinas$/);
    await expect(page.getByText('Treino A · Peito e tríceps')).toBeVisible();
    await expect(choice.getByRole('link', { name: 'Rotinas' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await choice.getByRole('link', { name: 'Catálogo' }).click();
    await expect(page).toHaveURL(/\/treino\/exercicios$/);
  });

  test('a barra de abas fica à vista com a lista longa, sem a página rolar para a esquerda', async ({
    page,
    context,
  }) => {
    await startTraining(context, page, { extra: 70 });
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    const box = await page.getByRole('navigation', { name: 'Abas do módulo' }).boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(Math.round(box!.y + box!.height)).toBeLessThanOrEqual(viewport.height);
    expect(box!.y).toBeGreaterThan(viewport.height / 2);
    await expectNoHorizontalScroll(page);
  });

  test('o cartão do Treino na Início já não é "Em breve" e leva à tela', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await page.goto('/');
    const card = page.locator('article[data-module="training"]');
    await expect(card).toBeVisible();
    await expect(card.locator('.badges')).not.toContainText('Em breve');
    await card.getByRole('link', { name: 'Ver treino' }).click();
    await expect(page).toHaveURL(/\/treino$/);
    await expect(page.locator('app-training-page')).toBeVisible();
  });

  test('a linha de sincronização diz que está em dia, e sem rede diz que usa o que está no aparelho', async ({
    page,
    context,
  }) => {
    const server = await startTraining(context, page);
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    await expect(page.getByText(/sincronizado às \d{2}:\d{2}/)).toBeVisible();
    server.offline = true;
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByText('Sem rede: usando o que está no aparelho')).toBeVisible();
    // Sem rede a lista continua lendo o aparelho.
    await expect(page.locator('.list .ui-row').first()).toBeVisible();
    server.offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText('Sem rede: usando o que está no aparelho')).toHaveCount(0);
  });
});

test.describe('casca do Treino com o service worker', () => {
  test.use({ serviceWorkers: 'allow' });

  test('/treino/ (o endereço do ícone) e /treino abrem a mesma tela', async ({ page }) => {
    await page.goto('/treino/');
    await waitForServiceWorkerControl(page);
    await expect(page.locator('app-training-page')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Abas do módulo' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Hoje' })).toBeVisible();
    const withSlash = await page.getByRole('heading', { name: 'Hoje' }).textContent();

    await page.goto('/treino');
    await expect(page.getByRole('heading', { name: 'Hoje' })).toBeVisible();
    expect(await page.getByRole('heading', { name: 'Hoje' }).textContent()).toBe(withSlash);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/treino/manifest.webmanifest',
    );
  });
});
