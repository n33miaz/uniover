import { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { seedBenchHistory } from './support/today-seed';
import {
  concludeSet,
  installClock,
  openToday,
  skipProgramChoice,
  stubDevice,
} from './support/today-pages';
import { openTraining, startTraining, waitForCatalog } from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

async function launch(context: BrowserContext, page: Page) {
  await installClock(page);
  await stubDevice(page, {});
  const server = await startTraining(context, page);
  seedBenchHistory(server);
}

const path = (page: Page) => new URL(page.url()).pathname;
const search = (page: Page) => new URL(page.url()).search;

/** Hoje, sem treino na tela: o endereço não tem nada além de `/treino`. */
async function expectToday(page: Page) {
  await expect.poll(() => path(page) + search(page)).toBe('/treino');
  await expect(page.locator('app-workout-day')).toHaveCount(0);
}

async function expectDay(page: Page) {
  await expect.poll(() => path(page)).toBe('/treino/sessao');
  await expect(page.locator('app-workout-day .exercise.suggested')).toBeVisible();
}

async function expectExercise(page: Page) {
  await expect.poll(() => path(page)).toBe('/treino/sessao/exercicio');
  // Com o descanso no ar o botão fixo de baixo sai: o cartão do descanso é o sinal de que o registro abriu.
  await expect(
    page.getByRole('button', { name: 'Concluir série' }).or(page.locator('.rest')),
  ).toBeVisible();
}

test.describe('os botões de voltar do treino', () => {
  test('cada voltar leva ao pai imediato: dia, exercício, descanso e resumo', async ({
    page,
    context,
  }) => {
    await launch(context, page);
    await openToday(page);

    // Hoje -> dia -> Hoje -> dia.
    await page.getByRole('button', { name: 'Iniciar Treino' }).click();
    await skipProgramChoice(page);
    await expectDay(page);
    await page.getByRole('link', { name: 'Voltar a Hoje' }).click();
    await expectToday(page);
    await page.getByRole('button', { name: 'Continuar Treino' }).click();
    await expectDay(page);

    // Dia -> exercício -> dia: o voltar do registro cai na lista, não em Hoje.
    await page.locator('app-workout-day .exercise.suggested').click();
    await expectExercise(page);
    await page.getByRole('button', { name: 'Voltar ao treino' }).click();
    await expectDay(page);

    // Exercício com descanso na tela: o voltar também cai na lista, e o descanso continua ao reabrir.
    await page.locator('app-workout-day .exercise.suggested').click();
    await expectExercise(page);
    await concludeSet(page);
    await expect(page.locator('.rest')).toBeVisible();
    await page.getByRole('button', { name: 'Voltar ao treino' }).click();
    await expectDay(page);
    await page.locator('app-workout-day .exercise.suggested').click();
    await expectExercise(page);
    await expect(page.locator('.rest')).toBeVisible();

    // Os atalhos do descanso também devolvem à lista.
    await page.getByRole('button', { name: 'Encerrar exercício' }).click();
    await expectDay(page);

    // Resumo -> Hoje (e não a tela do dia de um treino que acabou).
    await page.getByRole('button', { name: 'Concluir treino' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Treino concluído' })).toBeVisible();
    expect(search(page)).toContain('resumo=');
    await page.getByRole('button', { name: 'Voltar a Hoje' }).click();
    await expectToday(page);
    await expect(page.getByRole('button', { name: 'Iniciar Treino' })).toBeVisible();
  });

  test('recarregar no registro e voltar leva à lista do dia', async ({ page, context }) => {
    await launch(context, page);
    await openToday(page);
    await page.getByRole('button', { name: 'Iniciar Treino' }).click();
    await skipProgramChoice(page);
    await page.locator('app-workout-day .exercise.suggested').click();
    await expectExercise(page);

    await page.reload();
    await expectExercise(page);
    await page.getByRole('button', { name: 'Voltar ao treino' }).click();
    await expectDay(page);
  });

  test('o detalhe do exercício volta para a lista de exercícios', async ({ page, context }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    // Na raiz da lista o dono tem a seta para o Início; dentro do detalhe fica um voltar só, o da própria tela.
    await expect(page.locator('.training-header .back')).toHaveCount(1);
    await page.locator('.list .ui-row').first().click();
    await expect.poll(() => path(page)).toMatch(/^\/treino\/exercicios\/.+/);
    await expect(page.locator('.training-header .back')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Voltar para Exercícios' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Voltar para Exercícios' }).first().click();
    await expect.poll(() => path(page)).toBe('/treino/exercicios');
    await expect(page.locator('.training-header .back')).toHaveCount(1);
  });
});
