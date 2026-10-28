import { expect, expectNoHorizontalScroll, test, waitForServiceWorkerControl } from '../fixtures';
import { SEED_EXERCISE_IDS, SEED_ROUTINE_IDS } from './support/training-seed';
import {
  openTraining,
  startTraining,
  waitForCatalog,
  expectSynced,
  expectOfflineIcon,
  syncIcon,
} from './support/training-pages';

test.describe('casca do Treino', () => {
  // A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
  test.use({ serviceWorkers: 'block' });

  test('as três abas e as seções de progresso levam às telas corretas', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino');
    const tabs = page.getByRole('navigation', { name: 'Abas do módulo' });
    await expect(tabs.getByRole('link')).toHaveText(['Exercício', 'Início', 'Progresso']);
    await expect(tabs.getByRole('link', { name: 'Início' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await tabs.getByRole('link', { name: 'Exercício' }).click();
    await expect(page).toHaveURL(/\/treino\/exercicios$/);
    await expect(tabs.getByRole('link', { name: 'Exercício' })).toHaveAttribute(
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

    await page
      .getByRole('navigation', { name: 'Seções de progresso' })
      .getByRole('link', { name: 'Corpo' })
      .click();
    await expect(page).toHaveURL(/\/treino\/corpo$/);
    await expect(page.getByRole('heading', { name: 'Corpo', exact: true })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Progresso' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await tabs.getByRole('link', { name: 'Início' }).click();
    await expect(page).toHaveURL(/\/treino$/);
  });

  test('a aba Exercícios fica marcada na ficha, na lista filtrada e nas rotinas, e só ela', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    const tabs = page.getByRole('navigation', { name: 'Abas do módulo' });
    const marked = tabs.locator('a[aria-current="page"]');
    for (const url of [
      '/treino/exercicios',
      '/treino/exercicios?q=supino&group=chest',
      `/treino/exercicios/${SEED_EXERCISE_IDS.bench}`,
      '/treino/rotinas',
    ]) {
      await openTraining(page, url);
      await expect(tabs).toBeVisible();
      await expect(marked, url).toHaveText(['Exercício']);
    }
    for (const [url, label] of [
      ['/treino', 'Início'],
      ['/treino/progresso', 'Progresso'],
      ['/treino/corpo', 'Progresso'],
    ]) {
      await openTraining(page, url);
      await expect(marked, url).toHaveText([label]);
    }
  });

  test('a aba segue marcada ao filtrar a lista e ao voltar da ficha para a lista filtrada', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    const marked = page
      .getByRole('navigation', { name: 'Abas do módulo' })
      .locator('a[aria-current="page"]');
    await page.getByRole('searchbox', { name: 'Buscar exercício' }).fill('halteres');
    await expect(page.locator('.list .ui-row')).toHaveCount(4);
    await expect(marked).toHaveText(['Exercício']);
    await page.locator('.list .ui-row').first().click();
    await expect(page).toHaveURL(/\/treino\/exercicios\/[0-9a-f-]{36}$/);
    await expect(marked).toHaveText(['Exercício']);
    await page.goBack();
    await expect(page).toHaveURL(/q=halteres/);
    await expect(marked).toHaveText(['Exercício']);
  });

  test('o editor de rotina não tem barra de abas (nem como sair sem a confirmação)', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openTraining(page, `/treino/rotinas/${SEED_ROUTINE_IDS.a}`);
    await expect(page.getByRole('heading', { name: 'Editar rotina' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Abas do módulo' })).toHaveCount(0);
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

  test('o ícone de sincronização diz que está em dia e, sem rede, que usa o que está no aparelho', async ({
    page,
    context,
  }) => {
    const server = await startTraining(context, page);
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    await expectSynced(page);
    server.offline = true;
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expectOfflineIcon(page);
    // Sem rede a lista continua lendo o aparelho.
    await expect(page.locator('.list .ui-row').first()).toBeVisible();
    server.offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(syncIcon(page)).not.toHaveAttribute('data-state', 'offline');
  });
});

test.describe('casca do Treino com o service worker', () => {
  test.use({ serviceWorkers: 'allow' });

  // Aparelho que já teve uma sessão: a dica da última conta (que o app grava ao entrar) diz qual banco local abrir sem
  // esperar o `/me`. Sem ela, e sem rede nem sessão, o módulo só avisa que a conta está sendo confirmada.
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      localStorage.setItem('uniover.account-id', 'u1');
    });
  });

  test('/treino/ (o endereço do ícone) e /treino abrem a mesma tela', async ({ page }) => {
    await page.goto('/treino/');
    await waitForServiceWorkerControl(page);
    await expect(page.locator('app-training-page')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Abas do módulo' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Início' })).toBeVisible();
    const withSlash = await page.getByRole('heading', { name: 'Início' }).textContent();

    await page.goto('/treino');
    await expect(page.getByRole('heading', { name: 'Início' })).toBeVisible();
    expect(await page.getByRole('heading', { name: 'Início' }).textContent()).toBe(withSlash);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/treino/manifest.webmanifest',
    );
  });
});
