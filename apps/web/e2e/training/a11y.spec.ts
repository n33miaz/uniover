import { Page } from '@playwright/test';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { SEED_EXERCISE_IDS, SEED_ROUTINE_IDS } from './support/training-seed';
import {
  openTraining,
  startTraining,
  waitForCatalog,
  chooseMuscle,
} from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/**
 * Cada tela do Treino, nos dois temas: sem violação do axe (de qualquer gravidade), sem rolagem horizontal, com os alvos
 * de toque de pelo menos 44 px. O CSP é vigiado por todo teste (a fixture falha com qualquer violação). O movimento
 * fica reduzido: o axe e a medida veem a tela parada.
 */
interface Screen {
  readonly name: string;
  readonly open: (page: Page) => Promise<void>;
  readonly options?: { extra?: number };
}

const SCREENS: readonly Screen[] = [
  {
    name: 'lista de exercícios',
    open: async (page) => {
      await openTraining(page, '/treino/exercicios');
      await waitForCatalog(page);
    },
  },
  {
    name: 'lista com os dois blocos de filtro',
    open: async (page) => {
      await openTraining(page, '/treino/exercicios');
      await waitForCatalog(page);
      await page.getByRole('button', { name: 'Equipamento' }).click();
      await page.getByRole('button', { name: 'Barra', exact: true }).click();
      await expect(page.getByText('achado')).toBeVisible();
    },
  },
  {
    name: 'ficha com ilustração',
    open: async (page) => {
      await openTraining(page, `/treino/exercicios/${SEED_EXERCISE_IDS.bench}`);
      await expect(page.locator('app-exercise-illustration img').first()).toBeVisible();
    },
  },
  {
    name: 'ficha sem ilustração',
    open: async (page) => {
      await openTraining(page, `/treino/exercicios/${SEED_EXERCISE_IDS.plank}`);
      await expect(page.getByRole('heading', { name: 'Prancha isométrica' })).toBeVisible();
    },
  },
  {
    name: 'novo exercício com erros',
    open: async (page) => {
      await openTraining(page, '/treino/exercicios/novo');
      await page.getByRole('button', { name: 'Salvar exercício' }).click();
      await expect(page.getByText('Dê um nome ao exercício.')).toBeVisible();
    },
  },
  {
    name: 'lista de rotinas',
    open: async (page) => {
      await openTraining(page, '/treino/rotinas');
      await expect(page.locator('.next-card')).toBeVisible();
    },
  },
  {
    name: 'editor de rotina com um exercício aberto',
    open: async (page) => {
      await openTraining(page, `/treino/rotinas/${SEED_ROUTINE_IDS.a}`);
      await page
        .getByRole('button', { name: /Supino reto com barra/ })
        .first()
        .click();
      await expect(page.getByRole('group', { name: 'Séries' })).toBeVisible();
    },
  },
  {
    name: 'folha de adicionar a um treino',
    open: async (page) => {
      await openTraining(page, `/treino/exercicios/${SEED_EXERCISE_IDS.pushUp}`);
      await page.getByRole('button', { name: 'Adicionar a um treino' }).click();
      await expect(page.getByRole('dialog', { name: 'Adicionar a um treino' })).toBeVisible();
    },
  },
  {
    name: 'folha de modelos',
    open: async (page) => {
      await openTraining(page, '/treino/rotinas');
      await page.getByRole('button', { name: 'Comparar Modelos' }).click();
      await expect(page.getByRole('button', { name: /Full body/ })).toBeVisible();
    },
  },
  {
    name: 'tela provisória de Hoje',
    open: async (page) => {
      await openTraining(page, '/treino');
      await expect(page.getByRole('heading', { name: 'Início' })).toBeVisible();
    },
  },
];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`acessibilidade e medidas, tema ${scheme === 'light' ? 'claro' : 'escuro'}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    });

    for (const screen of SCREENS) {
      test(screen.name, async ({ page, context }) => {
        await startTraining(context, page, screen.options);
        await screen.open(page);
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        await settle(page);
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page);
        expect(await smallTargets(page)).toEqual([]);
      });
    }
  });
}

test.describe('pendências e movimento', () => {
  test('a folha das pendências não tem violações do axe', async ({ page, context }) => {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    const server = await startTraining(context, page);
    server.failNext({ method: 'PUT', path: /^exercises\//, status: 422, times: 1 });
    await openTraining(page, '/treino/exercicios/novo');
    await page.getByLabel('Nome').fill('Remada');
    await chooseMuscle(page, 'Meio das costas');
    await page.getByRole('button', { name: 'Salvar exercício' }).click();
    // Só com a falha já registrada o ícone abre a lista (antes disso o toque atualiza).
    await expect(page.getByText('1 com erro')).toBeVisible();
    await page.locator('.training-header .status').click();
    await expect(page.getByRole('dialog', { name: 'Alterações com erro' })).toBeVisible();
    await settle(page);
    await expectNoA11yViolations(page);
    expect(await smallTargets(page)).toEqual([]);
  });

  test('a ilustração só se mexe sem o pedido de movimento reduzido; com ele, há o botão', async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await startTraining(context, page);
    await openTraining(page, `/treino/exercicios/${SEED_EXERCISE_IDS.bench}`);
    await expect(page.getByRole('button', { name: 'Ver outra posição' })).toBeVisible();
  });

  test('o foco aparece em quem recebe a tabulação (busca e primeira linha)', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    await page.getByRole('searchbox', { name: 'Buscar exercício' }).focus();
    const outline = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement as Element);
      return { width: style.outlineWidth, style: style.outlineStyle, shadow: style.boxShadow };
    });
    // A busca troca o contorno por um anel de sombra (var(--a-ring)); o foco precisa ser visível por um dos dois.
    expect(outline.style !== 'none' || outline.shadow !== 'none').toBe(true);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => document.activeElement?.tagName);
    expect(['BUTTON', 'A', 'INPUT']).toContain(active);
  });
});
