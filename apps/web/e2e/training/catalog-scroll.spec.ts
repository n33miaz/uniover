import { expect, screenshot, test } from '../fixtures';
import { openTraining, startTraining, waitForCatalog } from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const rows = (page: import('@playwright/test').Page) => page.locator('.list .ui-row .name');

test.describe('catálogo grande', () => {
  test('rolar, mostrar mais e buscar respondem, e as miniaturas só carregam perto da tela', async ({
    page,
    context,
  }, info) => {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await startTraining(context, page, { extra: 150 });
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
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
    for (const total of [100, 150, 166]) {
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
      .toEqual(['Exercício de enchimento 139', 'Exercício de enchimento 39']);
  });
});
