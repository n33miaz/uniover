import { Page } from '@playwright/test';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { openTraining, startTraining } from './support/training-pages';
import { listChip, openMap, panel, seedExampleWeek, showFace, tapZone, zone } from './body-map-kit';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/**
 * O mapa do corpo nos dois temas e nos estados que mudam a tela: sem violação do axe (de qualquer gravidade), sem rolagem
 * horizontal e com os alvos de toque comuns (botões, links, chips) de pelo menos 44 px. As zonas do desenho têm teste de
 * área próprio (`body-map.spec.ts`). O movimento fica reduzido: o axe vê a tela parada, e a rolagem até o painel é imediata.
 */
interface State {
  readonly name: string;
  readonly open: (page: Page) => Promise<void>;
  readonly week?: boolean;
  readonly catalog?: boolean;
}

const STATES: readonly State[] = [
  { name: 'frente, sem registro', open: (page) => openMap(page) },
  {
    name: 'frente com volume e o painel aberto',
    week: true,
    open: async (page) => {
      await openMap(page);
      await tapZone(page, 'chest');
      await expect(panel(page).getByRole('heading', { name: 'Peitoral' })).toBeVisible();
    },
  },
  {
    name: 'costas com o painel de um músculo sem exercício',
    open: async (page) => {
      await openMap(page, '?face=back');
      await listChip(page, 'traps').click();
      await expect(panel(page).getByRole('heading', { name: 'Trapézio' })).toBeVisible();
    },
  },
  {
    name: 'costas com volume',
    week: true,
    open: async (page) => {
      await openMap(page);
      await showFace(page, 'Costas');
      await expect(zone(page, 'lats')).toHaveAttribute('data-level', '2');
    },
  },
  {
    name: 'catálogo que ainda não chegou',
    catalog: false,
    open: async (page) => {
      await openTraining(page, '/treino/exercicios/mapa');
      await expect(page.getByText('O catálogo ainda não chegou')).toBeVisible();
    },
  },
];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`mapa do corpo, acessibilidade e medidas, tema ${scheme === 'light' ? 'claro' : 'escuro'}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    });

    for (const state of STATES) {
      test(state.name, async ({ page, context }) => {
        const server = await startTraining(
          context,
          page,
          state.catalog === false ? { catalog: false } : {},
        );
        if (state.catalog === false) server.offline = true;
        if (state.week) seedExampleWeek(server);
        await state.open(page);
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        await settle(page);
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page);
        expect(await smallTargets(page)).toEqual([]);
      });
    }
  });
}
