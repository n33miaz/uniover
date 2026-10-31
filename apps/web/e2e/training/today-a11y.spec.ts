import { BrowserContext, Page } from '@playwright/test';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { seedBenchHistory, seedOpenElsewhere, HOURS } from './support/today-seed';
import {
  openSessionMenu,
  beginWorkout,
  concludeSet,
  installClock,
  menu,
  openToday,
  stubDevice,
  tap,
} from './support/today-pages';
import { startTraining } from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/**
 * Hoje, o treino ao vivo e o resumo, nos dois temas: sem violação do axe (de qualquer gravidade), sem rolagem horizontal
 * e com os alvos de toque de pelo menos 44 px. O CSP é vigiado por todo teste (a fixture falha com qualquer violação). O
 * movimento fica reduzido: o axe e a medida veem a tela parada.
 */
interface Screen {
  readonly name: string;
  readonly open: (page: Page, context: BrowserContext) => Promise<void>;
}

async function launch(context: BrowserContext, page: Page, vibrate = true) {
  await installClock(page);
  await stubDevice(page, { vibrate, wakeLock: true });
  const server = await startTraining(context, page);
  seedBenchHistory(server);
  return server;
}

const SCREENS: readonly Screen[] = [
  {
    name: 'Hoje com a rotina do dia',
    open: async (page, context) => {
      await launch(context, page);
      await openToday(page);
      await expect(page.locator('.lines .ui-row')).toHaveCount(3);
    },
  },
  {
    name: 'calendário mensal aberto',
    open: async (page, context) => {
      await launch(context, page);
      await openToday(page);
      await page.getByRole('button', { name: 'Ver Mês' }).click();
      await expect(page.getByRole('dialog', { name: /\d{4}$/ })).toBeVisible();
    },
  },
  {
    name: 'Hoje com treino aberto em outro aparelho (esquecido)',
    open: async (page, context) => {
      const server = await launch(context, page);
      seedOpenElsewhere(server, HOURS.thirteen);
      await openToday(page, { history: false });
      await expect(page.getByRole('button', { name: 'Encerrar o Treino Esquecido' })).toBeVisible();
    },
  },
  {
    name: 'treino ao vivo, série atual',
    open: async (page, context) => {
      await launch(context, page);
      await openToday(page);
      await beginWorkout(page);
      await page.getByRole('button', { name: 'Última Vez e Sugestão' }).click();
      await page.getByRole('button', { name: 'Por que esta sugestão?' }).click();
      await page.getByRole('button', { name: /Esforço \(RPE\)/ }).click();
      await page.getByRole('button', { name: 'Anotação' }).click();
    },
  },
  {
    name: 'treino ao vivo, recorde e descanso terminado',
    open: async (page, context) => {
      await launch(context, page, false);
      await openToday(page);
      await beginWorkout(page);
      await tap(page, 'Aumentar a carga');
      await tap(page, 'Diminuir as repetições', 2);
      await concludeSet(page);
      // O descanso começa depois de a série gravar: espera o cartão antes de empurrar o relógio.
      await expect(page.locator('.rest .time')).toBeVisible();
      await page.clock.fastForward(125_000);
      await expect(page.getByRole('heading', { name: 'Descanso terminou' })).toBeVisible();
    },
  },
  {
    name: 'menu do treino',
    open: async (page, context) => {
      await launch(context, page);
      await openToday(page);
      await beginWorkout(page);
      await openSessionMenu(page);
      await expect(page.getByRole('dialog', { name: 'Opções do Treino' })).toBeVisible();
    },
  },
  {
    name: 'folha de editar uma série',
    open: async (page, context) => {
      await launch(context, page);
      await openToday(page);
      await beginWorkout(page);
      await concludeSet(page);
      await page.locator('.done .ui-row').first().click();
      await expect(page.getByRole('dialog', { name: 'Editar Série' })).toBeVisible();
    },
  },
  {
    name: 'folha de substituir exercício',
    open: async (page, context) => {
      await launch(context, page);
      await openToday(page);
      await beginWorkout(page);
      await menu(page, /Substituir Exercício/);
      await expect(page.getByRole('dialog', { name: 'Substituir Exercício' })).toBeVisible();
    },
  },
  {
    name: 'resumo ao terminar',
    open: async (page, context) => {
      await launch(context, page);
      await openToday(page);
      await beginWorkout(page);
      await tap(page, 'Aumentar a carga');
      await concludeSet(page);
      await menu(page, /Terminar Treino/);
      await expect(page.getByRole('heading', { level: 1, name: 'Treino Concluído' })).toBeVisible();
    },
  },
];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`Hoje e treino ao vivo: acessibilidade e medidas, tema ${scheme === 'light' ? 'claro' : 'escuro'}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    });

    for (const screen of SCREENS) {
      test(screen.name, async ({ page, context }) => {
        await screen.open(page, context);
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        await settle(page);
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page);
        expect(await smallTargets(page)).toEqual([]);
      });
    }
  });
}
