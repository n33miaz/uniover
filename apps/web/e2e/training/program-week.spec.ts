import { Page } from '@playwright/test';
import { expect, screenshot, test } from '../fixtures';
import { beginWorkout, concludeSet, finishFromDay, stubDevice, tap } from './support/today-pages';
import { countRows, openTraining, startTraining } from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
// O fuso é fixo: o dia da semana vem do relógio do aparelho, e o teste precisa saber que dia é.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo' });

const item = (exerciseSlug: string, targetSets = 2) => ({
  exerciseSlug,
  targetSets,
  repMin: 8,
  repMax: 12,
  restSeconds: 60,
  supersetGroup: null,
});

/** Um programa seg/ter/qua, no formato do servidor para a prévia de comparação. */
const WEEK_PROGRAM = {
  items: [
    {
      id: 'divisao-teste',
      name: 'Divisão de teste',
      description: 'Três treinos, segunda a quarta.',
      routines: [
        { name: 'Segunda · Peito', weekdays: [1], items: [item('supino-reto-com-barra')] },
        { name: 'Terça · Costas', weekdays: [2], items: [item('remada-sentada-na-polia')] },
        { name: 'Quarta · Pernas', weekdays: [3], items: [item('agachamento-livre-com-barra')] },
      ],
    },
    {
      id: 'ab-teste',
      name: 'A/B de teste',
      description: 'Dois treinos alternados.',
      routines: [
        { name: 'A · Empurrar', weekdays: [1, 2, 3, 4, 5], items: [item('supino-reto-com-barra')] },
        { name: 'B · Puxar', weekdays: [1, 2, 3, 4, 5], items: [item('remada-sentada-na-polia')] },
      ],
    },
  ],
};

/** A segunda-feira (meio-dia em São Paulo) mais recente que já passou: o servidor simulado recusa relógio de mais de um dia à frente. */
function mondayNoon(): string {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() - 1);
  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/** Um dia da semana de teste (0 = segunda), ao meio-dia de São Paulo. */
const at = (offset: number): Date => {
  const base = new Date(`${mondayNoon()}T12:00:00-03:00`);
  base.setUTCDate(base.getUTCDate() + offset);
  return base;
};

const heading = (page: Page, name: string | RegExp) =>
  page.locator('.routine').getByRole('heading', { name });

async function chooseProgram(page: Page, name: RegExp, beforeChoosing?: () => void): Promise<void> {
  await openTraining(page, '/treino/rotinas');
  // As fichas nascem no aparelho: o catálogo precisa já ter chegado.
  await expect.poll(() => countRows(page, 'exercises')).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Comparar Modelos' }).click();
  const sheet = page.getByRole('dialog', { name: 'Comparar Modelos' });
  await expect(sheet.getByRole('button', { name })).toBeVisible();
  beforeChoosing?.();
  await sheet.getByRole('button', { name }).click();
  await sheet.getByRole('button', { name: 'Usar Este Modelo' }).click();
  await expect(page.getByText(/escolhido\. Hoje abre no treino do dia/)).toBeVisible();
}

async function start(page: Page, day: Date) {
  await page.clock.install({ time: day });
  await stubDevice(page, {});
}

test.describe('programa da semana', () => {
  test('conta sem programa vê as opções em Hoje, escolhe com um toque e a sugestão não volta', async ({
    page,
    context,
  }, info) => {
    await start(page, at(0));
    const server = await startTraining(context, page, { routines: false });
    server.templates = WEEK_PROGRAM;

    await openTraining(page, '/treino');
    await expect.poll(() => countRows(page, 'exercises')).toBeGreaterThan(0);
    const suggestion = page.locator('app-program-suggestion');
    await expect(suggestion.getByRole('heading', { name: 'Escolha seu programa' })).toBeVisible();
    await expect(suggestion).toContainText('Seg Peito · Ter Costas · Qua Pernas');
    await expect(suggestion).toContainText('Seg–sex alterna Empurrar / Puxar');
    await screenshot(page, info.outputPath('sugestao.png'));

    await suggestion.getByRole('button', { name: /Divisão de teste/ }).click();
    await expect(heading(page, 'Segunda · Peito')).toBeVisible();
    await expect(suggestion).toHaveCount(0);
    await expect
      .poll(() => server.rows('program').map((row) => row['programId']))
      .toEqual(['divisao-teste']);

    await page.reload();
    await expect(heading(page, 'Segunda · Peito')).toBeVisible();
    await expect(suggestion).toHaveCount(0);
  });

  test('escolhe o programa; segunda já abre pronta, termina, e na terça abre a terça', async ({
    page,
    context,
  }, info) => {
    await start(page, at(0));
    const server = await startTraining(context, page, { routines: false });
    server.templates = WEEK_PROGRAM;

    await chooseProgram(page, /Divisão de teste/);
    await expect.poll(() => server.rows('routines').length).toBe(3);
    expect(server.rows('routines').map((row) => row['programId'])).toEqual([
      'divisao-teste',
      'divisao-teste',
      'divisao-teste',
    ]);
    expect(server.rows('routines').map((row) => row['weekdays'])).toEqual([[1], [2], [3]]);
    await expect
      .poll(() => server.rows('program').map((row) => row['programId']))
      .toEqual(['divisao-teste']);

    await openTraining(page, '/treino');
    await expect(heading(page, 'Segunda · Peito')).toBeVisible();
    await screenshot(page, info.outputPath('segunda.png'));

    // Pronta para tocar: inicia, ajusta a carga, registra as séries e termina o dia.
    await beginWorkout(page, /Segunda - peito/);
    await tap(page, 'Aumentar a carga', 2);
    await concludeSet(page);
    await concludeSet(page);
    await finishFromDay(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Treino concluído' })).toBeVisible();
    await expect
      .poll(
        () =>
          server
            .rows('sets')
            .map((row) => row['weightKg'])
            .filter((kg) => (kg as number) > 0).length,
      )
      .toBe(2);

    // Terça: outro dia no relógio do aparelho, outro treino.
    await page.clock.setSystemTime(at(1));
    await openTraining(page, '/treino');
    await expect(heading(page, 'Terça · Costas')).toBeVisible();
    await expect(heading(page, 'Segunda · Peito')).toHaveCount(0);
    await screenshot(page, info.outputPath('terca.png'));
  });

  test('escolher sem rede grava no aparelho, funciona na hora e sobe quando a rede volta', async ({
    page,
    context,
  }) => {
    await start(page, at(0));
    const server = await startTraining(context, page, { routines: false });
    server.templates = WEEK_PROGRAM;

    await chooseProgram(page, /Divisão de teste/, () => {
      server.offline = true;
    });
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await openTraining(page, '/treino');
    await expect(heading(page, 'Segunda · Peito')).toBeVisible();
    expect(server.rows('routines')).toHaveLength(0);
    expect(server.rows('program')).toHaveLength(0);

    server.offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => server.rows('routines').length, { timeout: 20_000 }).toBe(3);
    await expect
      .poll(() => server.rows('program').map((row) => row['programId']))
      .toEqual(['divisao-teste']);
  });

  test('o app aberto vira o dia sozinho ao voltar do segundo plano e funciona sem rede', async ({
    page,
    context,
  }) => {
    await start(page, at(0));
    const server = await startTraining(context, page, { routines: false });
    server.templates = WEEK_PROGRAM;
    await chooseProgram(page, /Divisão de teste/);
    await openTraining(page, '/treino');
    await expect(heading(page, 'Segunda · Peito')).toBeVisible();

    // Sem rede e sem recarregar: o dia vem do relógio do aparelho.
    server.offline = true;
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.clock.setSystemTime(at(2));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(heading(page, 'Quarta · Pernas')).toBeVisible();

    await page.clock.setSystemTime(at(1));
    await page.reload();
    await expect(heading(page, 'Terça · Costas')).toBeVisible();
  });

  test('sábado e domingo mostram descanso e deixam iniciar um treino manual', async ({
    page,
    context,
  }, info) => {
    await start(page, at(0));
    const server = await startTraining(context, page, { routines: false });
    server.templates = WEEK_PROGRAM;
    await chooseProgram(page, /Divisão de teste/);

    await page.clock.setSystemTime(at(5));
    await openTraining(page, '/treino');
    await expect(heading(page, 'Dia de descanso')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Iniciar Treino', exact: true })).toHaveCount(0);
    await screenshot(page, info.outputPath('sabado.png'));

    await page.getByRole('button', { name: 'Iniciar treino manual' }).click();
    await expect(page.locator('app-workout-day .routine-name')).toHaveText('Treino livre');
  });

  test('A/B alterna nos dias de treino: segunda A, terça B', async ({ page, context }) => {
    await start(page, at(0));
    const server = await startTraining(context, page, { routines: false });
    server.templates = WEEK_PROGRAM;
    await chooseProgram(page, /A\/B de teste/);

    await openTraining(page, '/treino');
    await expect(heading(page, 'A · Empurrar')).toBeVisible();
    await beginWorkout(page, /A - empurrar/);
    await tap(page, 'Aumentar a carga', 2);
    await concludeSet(page);
    await concludeSet(page);
    await finishFromDay(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Treino concluído' })).toBeVisible();

    await page.clock.setSystemTime(at(1));
    await openTraining(page, '/treino');
    await expect(heading(page, 'B · Puxar')).toBeVisible();
  });

  test('trocar de programa troca o treino do dia; o anterior fica guardado', async ({
    page,
    context,
  }) => {
    await start(page, at(1));
    const server = await startTraining(context, page, { routines: false });
    server.templates = WEEK_PROGRAM;
    await chooseProgram(page, /Divisão de teste/);
    await openTraining(page, '/treino');
    await expect(heading(page, 'Terça · Costas')).toBeVisible();

    await chooseProgram(page, /A\/B de teste/);
    await openTraining(page, '/treino');
    await expect(heading(page, 'A · Empurrar')).toBeVisible();
    await expect
      .poll(() => server.rows('routines').filter((row) => row['active'] === false).length)
      .toBe(3);
  });
});
