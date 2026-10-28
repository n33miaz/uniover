import { BrowserContext, Page, TestInfo } from '@playwright/test';
import { join } from 'node:path';
import { settle } from '../screens/screen-helpers';
import { expect, screenshot, test } from '../fixtures';
import {
  HOURS,
  seedBenchHistory,
  seedOpenElsewhere,
  seedPastWorkout,
  seedSupersetRoutine,
} from './support/today-seed';
import {
  beginWorkout,
  concludeSet,
  installClock,
  menu,
  openToday,
  skipProgramChoice,
  stubDevice,
  tap,
  DeviceStubs,
} from './support/today-pages';
import { SEED_EXERCISE_IDS } from './support/training-seed';
import { startTraining } from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/**
 * Capturas de cada tela e estado de Hoje, do treino ao vivo e do resumo, nos dois viewports e nos dois temas. Vão para
 * `test-results/training-today`; para revisar a mão, aponte `TRAINING_SHOTS_DIR` para outra pasta.
 */
const DIR = process.env['TRAINING_SHOTS_DIR'] ?? 'test-results/training-today';

// A coleção inteira só roda para revisar a mão, com a pasta de destino indicada; na esteira entram só duas capturas.
const ESSENTIAL = new Set(['Hoje: a rotina do dia', 'Treino ao vivo: série atual e descanso']);

function shotTest(
  title: string,
  body: (fixtures: { page: Page; context: BrowserContext }, info: TestInfo) => Promise<void>,
) {
  if (process.env['TRAINING_SHOTS_DIR'] || ESSENTIAL.has(title)) test(title, body);
}

async function shot(page: Page, info: TestInfo, name: string, scheme: string): Promise<void> {
  await settle(page);
  await screenshot(page, join(DIR, `${name}-${scheme}-${info.project.name}.png`));
}

async function launch(
  context: BrowserContext,
  page: Page,
  options: { history?: boolean; stubs?: DeviceStubs; routines?: boolean; catalog?: boolean } = {},
) {
  await installClock(page);
  await stubDevice(page, options.stubs ?? {});
  const server = await startTraining(context, page, {
    routines: options.routines,
    catalog: options.catalog,
  });
  if (options.history !== false) seedBenchHistory(server);
  return server;
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`Hoje e treino ao vivo, tema ${scheme === 'light' ? 'claro' : 'escuro'}`, () => {
    test.beforeEach(async ({ page }) => {
      // Sem movimento: a captura vê a tela parada.
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    });

    shotTest('Hoje: a rotina do dia', async ({ page, context }, info) => {
      const server = await launch(context, page);
      seedPastWorkout(server, 2, 10 * 60_000, [
        { exerciseId: SEED_EXERCISE_IDS.pushdown, weightKg: 25, reps: 12 },
        { exerciseId: SEED_EXERCISE_IDS.pushdown, weightKg: 25, reps: 12 },
        { exerciseId: SEED_EXERCISE_IDS.curl, weightKg: 30, reps: 10 },
      ]);
      await openToday(page);
      await expect(page.locator('.lines .ui-row')).toHaveCount(3);
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      await shot(page, info, 'hoje', scheme);

      await page.getByRole('button', { name: 'Ver Mês' }).click();
      await expect(page.getByRole('dialog', { name: 'Mês com Ritmo' })).toBeVisible();
      await shot(page, info, 'calendario', scheme);
      await page
        .getByRole('dialog', { name: 'Mês com Ritmo' })
        .getByRole('button', { name: 'Fechar' })
        .click();
      await expect(page.getByRole('dialog', { name: 'Mês com Ritmo' })).toBeHidden();

      await page.getByRole('button', { name: 'Configurar Rotina' }).click();
      await expect(page.getByRole('dialog', { name: 'Configurar Rotina' })).toBeVisible();
      await shot(page, info, 'hoje-escolher-rotina', scheme);
    });

    shotTest('Hoje: semana sem treino', async ({ page, context }, info) => {
      await launch(context, page, { history: false });
      await openToday(page, { history: false });
      await expect(page.locator('.week .stats div').first()).toHaveText(/^Treinoss*0$/);
      await shot(page, info, 'hoje-semana-vazia', scheme);
    });

    shotTest('Hoje: sem rotinas', async ({ page, context }, info) => {
      await launch(context, page, { routines: false, history: false });
      await openToday(page, { history: false });
      await expect(page.getByRole('heading', { name: 'Sem Rotinas Ainda' })).toBeVisible();
      await shot(page, info, 'hoje-sem-rotinas', scheme);
    });

    shotTest('Hoje: catálogo que ainda não chegou', async ({ page, context }, info) => {
      const server = await launch(context, page, { catalog: false, history: false });
      server.offline = true;
      await page.goto('/treino');
      await expect(
        page.getByRole('heading', { name: 'O Catálogo Ainda Não Chegou' }),
      ).toBeVisible();
      await shot(page, info, 'hoje-catalogo-ausente', scheme);
    });

    shotTest('Hoje: treino aberto em outro aparelho', async ({ page, context }, info) => {
      const server = await launch(context, page);
      seedOpenElsewhere(server, HOURS.three);
      await openToday(page, { history: false });
      await expect(
        page.getByRole('heading', { name: 'Treino Aberto em Outro Aparelho' }),
      ).toBeVisible();
      await shot(page, info, 'hoje-bloqueado', scheme);
    });

    shotTest('Hoje: treino esquecido há mais de 12 horas', async ({ page, context }, info) => {
      const server = await launch(context, page);
      seedOpenElsewhere(server, HOURS.thirteen);
      await openToday(page, { history: false });
      await expect(page.getByRole('button', { name: 'Encerrar o Treino Esquecido' })).toBeVisible();
      await shot(page, info, 'hoje-esquecido', scheme);
      await page.getByRole('button', { name: 'Encerrar o Treino Esquecido' }).click();
      await expect(page.getByText('Encerrar o treino do outro aparelho?')).toBeVisible();
      await shot(page, info, 'hoje-esquecido-confirmar', scheme);
    });

    shotTest(
      'Hoje: treino em andamento e treino recusado pelo servidor',
      async ({ page, context }, info) => {
        const server = await launch(context, page);
        // O servidor recusa abrir o treino (outro aparelho tem um aberto): o aviso aparece em Hoje com "Reenviar".
        server.failNext({
          method: 'PUT',
          path: /^sessions\/[^/]+$/,
          status: 409,
          problem: 'session-already-open',
          times: 1,
        });
        await openToday(page);
        await beginWorkout(page);
        await concludeSet(page);
        await page.getByRole('button', { name: 'Voltar ao treino' }).click();
        await expect(page.locator('app-workout-day .exercise.suggested')).toBeVisible();
        await page.getByRole('link', { name: 'Voltar a Hoje' }).click();
        await expect(page.getByRole('button', { name: 'Continuar Treino' })).toBeVisible();
        await expect(page.getByText('O servidor não aceitou um treino')).toBeVisible();
        await shot(page, info, 'hoje-em-andamento', scheme);
      },
    );

    shotTest('Treino ao vivo: série atual', async ({ page, context }, info) => {
      await launch(context, page);
      await openToday(page);
      await beginWorkout(page);
      await expect(page.locator('app-focus-hint')).toContainText('42,5 kg × 6–8');
      await shot(page, info, 'sessao-inicio', scheme);

      await page.getByRole('button', { name: 'Por que esta sugestão?' }).click();
      await page.getByRole('button', { name: '8', exact: true }).click();
      await page.getByRole('button', { name: 'Anotação' }).click();
      await page.getByLabel('Anotação da série').fill('banco na altura 3');
      await shot(page, info, 'sessao-esforco-anotacao', scheme);
    });

    shotTest('Treino ao vivo: série atual e descanso', async ({ page, context }, info) => {
      await launch(context, page, { stubs: { vibrate: true } });
      await openToday(page);
      await beginWorkout(page);
      await tap(page, 'Aumentar a carga');
      await tap(page, 'Diminuir as repetições', 2);
      await concludeSet(page);
      await expect(page.getByRole('status').filter({ hasText: 'Recorde!' })).toBeVisible();
      await expect(page.locator('.rest .time')).toBeVisible();
      await shot(page, info, 'sessao-descanso-recorde', scheme);

      await page.clock.fastForward(125_000);
      await expect(page.getByRole('heading', { name: 'Descanso terminou' })).toBeVisible();
      await shot(page, info, 'sessao-descanso-terminou', scheme);
    });

    shotTest('Treino ao vivo: aparelho que não vibra', async ({ page, context }, info) => {
      await launch(context, page, { stubs: { vibrate: false } });
      await openToday(page);
      await beginWorkout(page);
      await concludeSet(page);
      await expect(page.getByText('Este aparelho não vibra')).toBeVisible();
      await shot(page, info, 'sessao-sem-vibracao', scheme);
    });

    shotTest('Treino ao vivo: sem histórico do exercício', async ({ page, context }, info) => {
      await launch(context, page, { history: false });
      await openToday(page, { history: false });
      await beginWorkout(page);
      await expect(page.getByText('Primeira vez neste exercício')).toBeVisible();
      await shot(page, info, 'sessao-primeira-vez', scheme);
    });

    shotTest('Treino ao vivo: menu, plano, troca e como fazer', async ({ page, context }, info) => {
      await launch(context, page, { stubs: { wakeLock: true } });
      await openToday(page);
      await beginWorkout(page);

      await page.getByRole('button', { name: 'Opções do Treino' }).click();
      await expect(page.getByRole('dialog', { name: 'Opções do Treino' })).toBeVisible();
      await shot(page, info, 'sessao-menu', scheme);
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /Exercícios do Treino/ })
        .click();
      await expect(page.getByRole('dialog', { name: 'Exercícios do Treino' })).toBeVisible();
      await expect(page.getByRole('dialog').getByText('0 de 4 séries')).toBeVisible();
      await shot(page, info, 'sessao-plano', scheme);
      await page.getByRole('dialog').getByRole('button', { name: 'Fechar', exact: true }).click();

      await menu(page, /Substituir Exercício/);
      await expect(page.getByRole('dialog', { name: 'Substituir Exercício' })).toBeVisible();
      await expect(
        page.getByRole('dialog').getByRole('button', { name: /Supino reto com halteres/ }),
      ).toBeVisible();
      await shot(page, info, 'sessao-trocar', scheme);
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /Supino reto com halteres/ })
        .click();
      await expect(page.locator('.chips')).toContainText('trocado só hoje');
      await shot(page, info, 'sessao-trocado', scheme);

      await menu(page, /Como Fazer/);
      await expect(page.getByRole('dialog', { name: 'Supino reto com halteres' })).toBeVisible();
      await shot(page, info, 'sessao-como-fazer', scheme);
    });

    shotTest(
      'Treino ao vivo: miniatura e como fazer com ilustração',
      async ({ page, context }, info) => {
        await launch(context, page);
        await openToday(page);
        await beginWorkout(page);
        await expect(page.locator('.thumb app-exercise-illustration img').first()).toBeVisible();
        await menu(page, /Como Fazer/);
        const dialog = page.getByRole('dialog', { name: 'Supino reto com barra' });
        await expect(dialog.locator('app-exercise-illustration img').first()).toBeVisible();
        await shot(page, info, 'sessao-como-fazer-arte', scheme);
      },
    );

    shotTest('Treino ao vivo: editar uma série', async ({ page, context }, info) => {
      await launch(context, page);
      await openToday(page);
      await beginWorkout(page);
      await concludeSet(page);
      await shot(page, info, 'sessao-serie-feita', scheme);
      await page.locator('.done .ui-row').first().click();
      await expect(page.getByRole('dialog', { name: 'Editar Série' })).toBeVisible();
      await shot(page, info, 'sessao-editar-serie', scheme);
    });

    shotTest('Treino ao vivo: supersérie', async ({ page, context }, info) => {
      const server = await launch(context, page);
      seedSupersetRoutine(server);
      await openToday(page);
      await page.getByRole('button', { name: 'Configurar Rotina' }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /Treino C/ })
        .click();
      await beginWorkout(page, /Treino C/);
      await concludeSet(page);
      await expect(
        page.getByRole('heading', { level: 2, name: 'Tríceps na polia com corda' }),
      ).toBeVisible();
      await expect(page.locator('.rest')).toHaveCount(0);
      await shot(page, info, 'sessao-supersérie', scheme);
    });

    shotTest('Treino ao vivo: plano concluído', async ({ page, context }, info) => {
      await launch(context, page);
      await openToday(page);
      await beginWorkout(page);
      for (let index = 0; index < 3; index++) {
        await menu(page, /Pular Exercício/);
      }
      await expect(page.getByText('A Rotina de Hoje Acabou')).toBeVisible();
      await shot(page, info, 'sessao-plano-concluido', scheme);
    });

    shotTest(
      'Treino ao vivo: treino livre e exercício de tempo',
      async ({ page, context }, info) => {
        await launch(context, page, { history: false });
        await openToday(page, { history: false });
        await page.getByRole('button', { name: 'Treino Livre' }).click();
        await skipProgramChoice(page);
        await expect(page.locator('app-workout-day .routine-name')).toHaveText('Treino Livre');
        await shot(page, info, 'sessao-livre-vazio', scheme);
        await page.getByRole('button', { name: 'Escolher Exercício' }).click();
        await page
          .getByRole('dialog')
          .getByRole('button', { name: /Prancha isométrica/ })
          .click();
        await expect(
          page.getByRole('heading', { level: 2, name: 'Prancha isométrica' }),
        ).toBeVisible();
        await shot(page, info, 'sessao-tempo', scheme);
      },
    );

    shotTest('Resumo ao terminar', async ({ page, context }, info) => {
      await launch(context, page);
      await openToday(page);
      await beginWorkout(page);
      await tap(page, 'Aumentar a carga');
      await tap(page, 'Diminuir as repetições', 2);
      await concludeSet(page);
      await concludeSet(page);
      await page.clock.fastForward(25 * 60_000);
      await menu(page, /Terminar Treino/);
      await expect(page.getByRole('heading', { level: 1, name: 'Treino Concluído' })).toBeVisible();
      await expect(page.locator('.records .ui-row')).toHaveCount(2);
      await shot(page, info, 'resumo', scheme);

      await page.getByRole('button', { name: 'Editar Treino' }).click();
      await expect(page.locator('.sets .ui-row')).toHaveCount(2);
      await page.getByRole('button', { name: 'Editar Treino' }).scrollIntoViewIfNeeded();
      await shot(page, info, 'resumo-editar', scheme);
    });
  });
}
