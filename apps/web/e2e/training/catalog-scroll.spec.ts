import { expect, screenshot, test } from '../fixtures';
import { openTraining, startTraining, waitForCatalog } from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

type Page = import('@playwright/test').Page;

const rows = (page: Page) => page.locator('.list .ui-row .name');

// 16 do catálogo-semente + 300 de enchimento: passam de uma página do pull (200 linhas) e do tamanho em que o WebKit
// travava a leitura por cursor. O catálogo de verdade tem perto de 270.
const EXTRA = 300;
const TOTAL = 316;
const countLabel = (page: Page) => page.getByRole('status').filter({ hasText: /exercícios$/ });

test.describe('catálogo grande', () => {
  test('rolar, mostrar mais e buscar respondem, e as miniaturas só carregam perto da tela', async ({
    page,
    context,
  }, info) => {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    const server = await startTraining(context, page, { extra: EXTRA });
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    // As duas páginas do pull chegaram e a lista inteira foi relida (o total é o do catálogo todo, não o da 1ª página).
    await expect(countLabel(page)).toHaveText(`${TOTAL} exercícios`, {
      timeout: 25_000,
    });
    expect(
      server.hits.filter((hit) => hit.method === 'GET' && hit.path.includes('exercises')).length,
    ).toBeGreaterThanOrEqual(2);
    await expect(rows(page)).toHaveCount(50);
    await screenshot(page, `test-results/catalog-scroll/list-${info.project.name}.png`);

    // As figuras das linhas esperam a vez de aparecer: o aparelho não decodifica 50 de uma vez.
    const thumbs = page.locator('.list .thumb img');
    expect(await thumbs.count()).toBeGreaterThan(0);
    expect(await thumbs.evaluateAll((all) => all.every((img) => img.loading === 'lazy'))).toBe(
      true,
    );
    expect(await thumbs.evaluateAll((all) => all.every((img) => img.decoding === 'async'))).toBe(
      true,
    );

    // Rolar até o fim e pedir mais, em sequência, sem esperar tempo fixo: o estado é que manda.
    for (const total of [100, 150, 200, 250, 300, TOTAL]) {
      const more = page.getByRole('button', { name: /^Mostrar Mais/ });
      await more.scrollIntoViewIfNeeded();
      await more.click();
      await expect(rows(page)).toHaveCount(total);
    }
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);

    // A busca estreita a lista inteira (todas as linhas), não só as que estavam à mostra.
    const search = page.getByRole('searchbox', { name: 'Buscar exercício' });
    await search.fill('enchimento 39');
    await expect
      .poll(async () => (await rows(page).allTextContents()).sort())
      .toEqual([
        'Exercício de enchimento 139',
        'Exercício de enchimento 239',
        'Exercício de enchimento 39',
      ]);
  });

  test('a busca responde depois do pull e nunca fica esperando o banco', async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await startTraining(context, page, { extra: EXTRA });
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    await expect(countLabel(page)).toHaveText(`${TOTAL} exercícios`, { timeout: 25_000 });

    // O pull terminou de gravar: cada busca seguinte relê o catálogo e responde, sem travar na leitura.
    const search = page.getByRole('searchbox', { name: 'Buscar exercício' });
    await search.fill('enchimento 299');
    await expect(rows(page)).toHaveText(['Exercício de enchimento 299']);
    await search.fill('enchimento 2');
    await expect(page.getByRole('status').filter({ hasText: /achados$/ })).toHaveText(
      '138 exercícios achados',
    );
    await search.fill('zzzz');
    await expect(page.getByText('Nenhum Exercício Achado')).toBeVisible();
    await search.fill('');
    await expect(countLabel(page)).toHaveText(`${TOTAL} exercícios`);

    // O filtro por grupo também lê o catálogo inteiro e responde.
    await page
      .getByRole('group', { name: 'Filtrar por grupo muscular' })
      .getByRole('button', { name: 'Peito' })
      .click();
    await expect(page.getByRole('status').filter({ hasText: /exercícios/ })).not.toHaveText(
      new RegExp(`^${TOTAL} exercícios$`),
    );
  });
});
