import { BrowserContext, Page, TestInfo } from '@playwright/test';
import { join } from 'node:path';
import { settle } from '../screens/screen-helpers';
import { expect, screenshot, test } from '../fixtures';
import {
  openTraining,
  startTraining,
  waitForCatalog,
  expectOfflineIcon,
} from './support/training-pages';
import { listChip, openMap, panel, seedExampleWeek, showFace, tapZone, zone } from './body-map-kit';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/**
 * Capturas do mapa do corpo em cada estado, nos dois viewports e nos dois temas. Vão para `test-results/training-body-map`;
 * para revisar a mão, aponte `TRAINING_SHOTS_DIR` para outra pasta.
 */
const DIR = process.env['TRAINING_SHOTS_DIR'] ?? 'test-results/training-body-map';

// A coleção inteira só roda para revisar a mão, com a pasta de destino indicada; na esteira entram só duas capturas.
const ESSENTIAL = new Set(['Mapa: frente com volume da semana', 'Mapa: painel aberto']);

interface Fixtures {
  page: Page;
  context: BrowserContext;
}

function shotTest(title: string, body: (fixtures: Fixtures, info: TestInfo) => Promise<void>) {
  if (process.env['TRAINING_SHOTS_DIR'] || ESSENTIAL.has(title)) test(title, body);
}

async function shot(
  page: Page,
  info: TestInfo,
  name: string,
  scheme: string,
  options: { fullPage?: boolean } = {},
): Promise<void> {
  await settle(page);
  await screenshot(page, join(DIR, `${name}-${scheme}-${info.project.name}.png`), options);
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`mapa do corpo, tema ${scheme === 'light' ? 'claro' : 'escuro'}`, () => {
    test.beforeEach(async ({ page }) => {
      // Sem movimento: a rolagem até o painel é imediata e a captura vê a tela parada.
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    });

    shotTest('Mapa: frente sem registro', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openMap(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      await shot(page, info, 'mapa-frente-sem-registro', scheme);
    });

    shotTest('Mapa: frente com volume da semana', async ({ page, context }, info) => {
      const server = await startTraining(context, page);
      seedExampleWeek(server);
      await openMap(page);
      await expect(zone(page, 'chest')).toHaveAttribute('data-level', '3');
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      await shot(page, info, 'mapa-frente', scheme);
    });

    shotTest('Mapa: costas com volume da semana', async ({ page, context }, info) => {
      const server = await startTraining(context, page);
      seedExampleWeek(server);
      await openMap(page);
      await showFace(page, 'Costas');
      await expect(zone(page, 'lats')).toHaveAttribute('data-level', '2');
      await shot(page, info, 'mapa-costas', scheme);
    });

    shotTest('Mapa: painel aberto', async ({ page, context }, info) => {
      const server = await startTraining(context, page);
      seedExampleWeek(server);
      await openMap(page);
      await expect(zone(page, 'chest')).toHaveAttribute('data-level', '3');
      await tapZone(page, 'chest');
      await expect(panel(page).getByRole('heading', { name: 'Peitoral' })).toBeVisible();
      await expect(panel(page).getByRole('link', { name: /^Ver todos/ })).toBeInViewport();
      await shot(page, info, 'mapa-painel', scheme);
      await shot(page, info, 'mapa-painel-pagina', scheme, { fullPage: true });
    });

    shotTest('Mapa: painel das costas', async ({ page, context }, info) => {
      const server = await startTraining(context, page);
      seedExampleWeek(server);
      await openMap(page);
      await showFace(page, 'Costas');
      await expect(zone(page, 'lats')).toHaveAttribute('data-level', '2');
      await tapZone(page, 'lats');
      await expect(panel(page).getByRole('heading', { name: 'Dorsais' })).toBeVisible();
      await expect(panel(page).getByText('5 séries nesta semana')).toBeVisible();
      await shot(page, info, 'mapa-painel-costas', scheme);
    });

    shotTest('Mapa: painel de um músculo sem série na semana', async ({ page, context }, info) => {
      const server = await startTraining(context, page);
      seedExampleWeek(server);
      await openMap(page);
      await expect(zone(page, 'chest')).toHaveAttribute('data-level', '3');
      await tapZone(page, 'abdominals');
      await expect(panel(page).getByText('Nenhuma série nesta semana')).toBeVisible();
      await shot(page, info, 'mapa-painel-sem-serie', scheme);
    });

    shotTest('Mapa: painel de um músculo sem exercício', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openMap(page);
      await tapZone(page, 'neck');
      await expect(
        panel(page).getByText('Nenhum exercício deste músculo no catálogo.'),
      ).toBeVisible();
      await shot(page, info, 'mapa-painel-sem-exercicio', scheme);
    });

    shotTest('Mapa: sem rede, usando o que está no aparelho', async ({ page, context }, info) => {
      const server = await startTraining(context, page);
      seedExampleWeek(server);
      await openTraining(page, '/treino/exercicios');
      await waitForCatalog(page);
      // Com rede, o aparelho traz o catálogo e o treino da semana; só então a rede cai.
      await page.getByRole('link', { name: 'Mapa do corpo' }).click();
      await expect(zone(page, 'chest')).toHaveAttribute('data-level', '3');
      await page.getByRole('button', { name: 'Voltar para Exercícios' }).click();
      server.offline = true;
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await expectOfflineIcon(page);
      await page.getByRole('link', { name: 'Mapa do corpo' }).click();
      await expect(zone(page, 'chest')).toHaveAttribute('data-level', '3');
      await tapZone(page, 'chest');
      await expect(panel(page).getByRole('heading', { name: 'Peitoral' })).toBeVisible();
      await shot(page, info, 'mapa-sem-rede', scheme);
    });

    shotTest('Mapa: lista alternativa de músculos', async ({ page, context }, info) => {
      const server = await startTraining(context, page);
      seedExampleWeek(server);
      await openMap(page, '?muscle=quadriceps');
      await expect(panel(page).getByRole('heading', { name: 'Quadríceps' })).toBeVisible();
      await expect(panel(page).getByText('3 séries nesta semana')).toBeVisible();
      await listChip(page, 'calves').scrollIntoViewIfNeeded();
      await page.getByRole('heading', { name: 'Ou escolha pela lista' }).scrollIntoViewIfNeeded();
      await shot(page, info, 'mapa-lista', scheme);
      await shot(page, info, 'mapa-lista-pagina', scheme, { fullPage: true });
    });

    shotTest('Mapa: foco de teclado numa zona', async ({ page, context }, info) => {
      const server = await startTraining(context, page);
      seedExampleWeek(server);
      await openMap(page);
      await expect(zone(page, 'chest')).toHaveAttribute('data-level', '3');
      await zone(page, 'biceps').focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(zone(page, 'biceps')).toBeFocused();
      await shot(page, info, 'mapa-foco', scheme);
    });

    shotTest('Mapa: catálogo que ainda não chegou, sem rede', async ({ page, context }, info) => {
      const server = await startTraining(context, page, { catalog: false });
      server.offline = true;
      await openTraining(page, '/treino/exercicios/mapa');
      await expect(page.getByText('O catálogo ainda não chegou')).toBeVisible();
      await shot(page, info, 'mapa-catalogo-vazio', scheme);
    });
  });
}
