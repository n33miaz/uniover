import { BrowserContext, Page, TestInfo } from '@playwright/test';
import { join } from 'node:path';
import { settle } from '../screens/screen-helpers';
import { expect, screenshot, test } from '../fixtures';
import { STATES, section } from './progress-states';
import { expectChartDrawn, openProgress, startProgress } from './progress-support';
import { TrainingServer } from './support/training-server';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

/**
 * Capturas de cada estado da tela de Progresso, nos dois viewports e nos dois temas. Vão para `test-results/training`; para
 * revisar a mão, aponte `TRAINING_SHOTS_DIR` para outra pasta. A coleção inteira só roda com a pasta indicada; na esteira
 * entra só a primeira captura, para a tela abrir e o print sair sem custar login e captura demais no WebKit do Linux.
 */
const DIR = process.env['TRAINING_SHOTS_DIR'] ?? 'test-results/training';
const ALL = Boolean(process.env['TRAINING_SHOTS_DIR']);

const slug = (name: string) =>
  name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** A captura espera a primeira sincronização acabar e as leituras do aparelho se assentarem: sem isso o print pega a tela no meio do carregamento. */
async function steady(page: Page): Promise<void> {
  await expect(page.locator('.training-header .status')).toHaveAttribute(
    'aria-label',
    /Sincronizado às|Sem rede/,
  );
  await expect(page.locator('.ui-skeleton')).toHaveCount(0);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)));
}

async function shot(page: Page, info: TestInfo, name: string, scheme: string): Promise<void> {
  await steady(page);
  await settle(page);
  await screenshot(page, join(DIR, `${name}-${scheme}-${info.project.name}.png`));
}

/** Estados que só valem para as capturas (os de acessibilidade ficam em `progress-states`). */
interface ExtraShot {
  readonly name: string;
  readonly run: (page: Page, context: BrowserContext, server: TrainingServer) => Promise<void>;
}

const EXTRAS: readonly ExtraShot[] = [
  {
    name: 'gráfico com meta, sem rede',
    run: async (page, context, server) => {
      await openProgress(page);
      await page.getByRole('button', { name: 'Definir meta' }).click();
      const sheet = page.getByRole('dialog', { name: /^Meta de 1RM/ });
      await sheet.getByLabel('Meta de 1RM, em kg').fill('55');
      await sheet.getByRole('button', { name: 'Salvar' }).click();
      await expect(page.getByRole('button', { name: /^Meta: 55 kg/ })).toBeVisible();
      // O pedaço do gráfico só vem da rede: o desenho tem de existir antes de cortá-la.
      await expectChartDrawn(page);
      server.offline = true;
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      // O estado sem rede mora no ícone do cabeçalho (a faixa de texto só existe com envio pendente, e isso depende da fila).
      await expect(page.locator('.training-header .status')).toHaveAttribute(
        'data-state',
        'offline',
      );
      await expectChartDrawn(page);
    },
  },
  {
    name: 'seis meses',
    run: async (page) => {
      await openProgress(page);
      await page.getByRole('button', { name: '6 meses', exact: true }).click();
      await expect(page.locator('app-progress-evolution .delta')).toHaveText('+14 kg desde 10/06');
      await expectChartDrawn(page);
    },
  },
  {
    name: 'semana anterior',
    run: async (page) => {
      await openProgress(page);
      await section(page, /^Semana/).click();
      await page.getByRole('button', { name: 'Semana anterior' }).click();
      await expect(page.locator('app-progress-week .range b')).toHaveText('12 a 18 de outubro');
    },
  },
  {
    name: 'semana que cruza o mês',
    run: async (page) => {
      await openProgress(page);
      await section(page, /^Semana/).click();
      for (let index = 0; index < 3; index++) {
        await page.getByRole('button', { name: 'Semana anterior' }).click();
      }
      await expect(page.locator('app-progress-week .range b')).toHaveText(
        '28 de setembro a 4 de outubro',
      );
    },
  },
  {
    name: 'mês anterior',
    run: async (page) => {
      await openProgress(page);
      await section(page, /^Frequência/).click();
      await page.getByRole('button', { name: 'Mês anterior' }).click();
      await expect(page.locator('app-progress-frequency .range b')).toHaveText('Setembro de 2026');
    },
  },
  {
    name: 'todas as seções abertas',
    run: async (page) => {
      await openProgress(page);
      for (const title of [/^Recordes/, /^Semana/, /^Frequência/, /^Exportar e compartilhar/]) {
        await section(page, title).click();
      }
      await expect(page.locator('app-progress-frequency .day.on')).toHaveCount(5);
    },
  },
];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`telas de Progresso, tema ${scheme === 'light' ? 'claro' : 'escuro'}`, () => {
    test.beforeEach(async ({ page }) => {
      // Sem movimento: a captura e o axe veem a tela parada.
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    });

    STATES.forEach((state, index) => {
      if (!ALL && index !== 0) return;
      test(`Progresso: ${state.name}`, async ({ page, context }, info) => {
        await startProgress(context, page, state.options);
        await state.open(page);
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        await shot(page, info, slug(state.name), scheme);
        // Os estados longos (seções abertas) também ganham a captura da página inteira.
        if (ALL && /aberta|aberto/.test(state.name)) {
          await settle(page);
          await screenshot(
            page,
            join(DIR, `${slug(state.name)}-inteira-${scheme}-${info.project.name}.png`),
            {
              fullPage: true,
            },
          );
        }
      });
    });

    if (ALL) {
      for (const extra of EXTRAS) {
        test(`Progresso: ${extra.name}`, async ({ page, context }, info) => {
          const server = await startProgress(context, page);
          await extra.run(page, context, server);
          await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
          await shot(page, info, slug(extra.name), scheme);
          await screenshot(
            page,
            join(DIR, `${slug(extra.name)}-inteira-${scheme}-${info.project.name}.png`),
            {
              fullPage: true,
            },
          );
          await context.setOffline(false);
        });
      }
    }
  });
}
