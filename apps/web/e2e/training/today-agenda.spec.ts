import { Page } from '@playwright/test';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { settle, smallTargets } from '../screens/screen-helpers';
import { stubDevice } from './support/today-pages';
import { countRows, openTraining, startTraining } from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
// O fuso é fixo: o dia da semana vem do relógio do aparelho, e o teste precisa saber que dia é.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo' });

const item = (exerciseSlug: string) => ({
  exerciseSlug,
  targetSets: 2,
  repMin: 8,
  repMax: 12,
  restSeconds: 60,
  supersetGroup: null,
});

/** Um programa seg/ter/qua: três dias de treino por semana, o resto é descanso. */
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
const isoDay = (offset: number) => at(offset).toISOString().slice(0, 10);

const routineHeading = (page: Page, name: string | RegExp) =>
  page.locator('.routine').getByRole('heading', { name });

/** Segunda ao meio-dia, programa seg/ter/qua escolhido pela sugestão de Hoje. */
async function openProgramWeek(page: Page, context: Parameters<typeof startTraining>[0]) {
  await page.clock.install({ time: at(0) });
  await stubDevice(page, {});
  const server = await startTraining(context, page, { routines: false });
  server.templates = WEEK_PROGRAM;
  await openTraining(page, '/treino');
  await expect.poll(() => countRows(page, 'exercises')).toBeGreaterThan(0);
  await page
    .locator('app-program-suggestion')
    .getByRole('button', { name: /Divisão de teste/ })
    .click();
  await expect(routineHeading(page, 'Segunda · Peito')).toBeVisible();
  return server;
}

const week = (page: Page) => page.locator('app-week-calendar');

async function openConfig(page: Page) {
  await page.getByRole('button', { name: 'Configurar Rotina' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurar Rotina' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Hoje: semana com meta e agenda', () => {
  test('os dias mostram hoje, planejado e descanso, e o rodapé conta a meta do programa', async ({
    page,
    context,
  }) => {
    await openProgramWeek(page, context);

    const days = week(page).locator('.week-days .day');
    await expect(days).toHaveCount(7);
    // A semana vai de domingo a sábado: hoje é a segunda, a segunda da fila (o domingo já passou).
    await expect(days.nth(0)).toHaveText(/dom/);
    await expect(days.nth(1)).toHaveClass(/today/);
    await expect(week(page).locator('.day.planned')).toHaveCount(2); // terça e quarta
    await expect(week(page).locator('.day.rest')).toHaveCount(3); // quinta a sábado
    await expect(days.nth(3)).toHaveAccessibleName(/treino planejado/);
    await expect(days.nth(5)).toHaveAccessibleName(/descanso/);
    await expect(week(page).locator('.week-count')).toContainText('0 de 3');
    await expect(week(page).locator('.week-progress span').first()).toHaveText(
      'Faltam 3 nesta semana',
    );
    await expect(week(page).getByRole('button', { name: 'Ver Mês' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('tocar num dia planejado escolhe a rotina dele para hoje', async ({ page, context }) => {
    await openProgramWeek(page, context);

    await week(page).locator('.day.planned').first().click();
    await expect(routineHeading(page, 'Terça · Costas')).toBeVisible();
  });

  test('a meta flexível ajusta, e Voltar ao Padrão devolve a do programa', async ({
    page,
    context,
  }) => {
    await openProgramWeek(page, context);

    const dialog = await openConfig(page);
    await dialog.getByLabel('Treinos por semana').fill('2');
    await dialog.getByRole('button', { name: 'Salvar Meta' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Meta salva');
    await dialog.getByRole('button', { name: 'Fechar' }).click();
    await expect(week(page).locator('.week-count')).toContainText('0 de 2');
    await expect(week(page).locator('.week-progress')).toContainText('Faltam 2 nesta semana');

    const reopened = await openConfig(page);
    await reopened.getByRole('button', { name: 'Voltar ao Padrão' }).click();
    await reopened.getByRole('button', { name: 'Fechar' }).click();
    await expect(week(page).locator('.week-count')).toContainText('0 de 3');
  });

  test('a ausência planejada tira o dia da meta e pode ser desfeita', async ({ page, context }) => {
    await openProgramWeek(page, context);

    const dialog = await openConfig(page);
    await dialog.getByLabel('De', { exact: true }).fill(isoDay(1));
    await dialog.getByLabel('Até', { exact: true }).fill(isoDay(3));
    await dialog.getByRole('button', { name: 'Marcar Ausência' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Ausência marcada');
    await dialog.getByRole('button', { name: 'Fechar' }).click();

    await expect(week(page).locator('.day.absent')).toHaveCount(3);
    await expect(week(page).locator('.day.planned')).toHaveCount(0);
    // Terça e quarta eram de treino (quinta é descanso): duas das três sessões saem da meta, e falta uma.
    await expect(week(page).locator('.week-progress')).toContainText('Falta 1 nesta semana');

    const reopened = await openConfig(page);
    await reopened.getByLabel('De', { exact: true }).fill(isoDay(1));
    await reopened.getByLabel('Até', { exact: true }).fill(isoDay(3));
    await reopened.getByRole('button', { name: 'Desfazer' }).click();
    await expect(reopened.getByRole('status')).toHaveText('Ausência desfeita');
    await reopened.getByRole('button', { name: 'Fechar' }).click();
    await expect(week(page).locator('.day.absent')).toHaveCount(0);
    await expect(week(page).locator('.day.planned')).toHaveCount(2);
  });

  test('a nota do dia vai para o servidor e aparece no mês, no dia dela', async ({
    page,
    context,
  }) => {
    const server = await openProgramWeek(page, context);

    const dialog = await openConfig(page);
    await dialog.getByRole('textbox', { name: 'Nota do dia' }).fill('Academia cheia');
    await dialog.getByRole('button', { name: 'Salvar Nota' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Nota salva');
    await dialog.getByRole('button', { name: 'Fechar' }).click();

    await expect
      .poll(() => server.rows('calendar-entries').map((row) => row['note']))
      .toEqual(['Academia cheia']);

    await week(page).getByRole('button', { name: 'Ver Mês' }).click();
    const month = page.getByRole('dialog', { name: /\d{4}$/ });
    await expect(month).toBeVisible();
    await expect(month.locator('.streak')).toBeVisible();
    await expect(month.locator('.day-detail')).toContainText('Academia cheia');
    await settle(page);
    expect(await smallTargets(page)).toEqual([]);
  });
});

test.describe('barra de baixo do Treino', () => {
  test('ícone acima do rótulo, rótulos sempre visíveis, pílula só no ativo e alvos de 44 px', async ({
    page,
    context,
  }) => {
    await stubDevice(page, {});
    await startTraining(context, page);
    await openTraining(page, '/treino');

    const bar = page.getByRole('navigation', { name: 'Abas do módulo' });
    const links = bar.getByRole('link');
    await expect(links).toHaveCount(3);
    await expect(links.nth(1)).toHaveText('Início');
    await expect(links.nth(1)).toHaveAttribute('aria-current', 'page');
    await expect(links.nth(0)).not.toHaveAttribute('aria-current', 'page');
    await expect(links.nth(2)).not.toHaveAttribute('aria-current', 'page');

    for (let index = 0; index < 3; index++) {
      const link = links.nth(index);
      const box = (await link.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      // O ícone fica acima do rótulo.
      const pill = (await link.locator('.pill').boundingBox())!;
      const label = (await link.locator(':scope > span:not(.pill)').boundingBox())!;
      expect(pill.y + pill.height).toBeLessThanOrEqual(label.y + 1);
    }

    const background = (index: number) =>
      links
        .nth(index)
        .locator('.pill')
        .evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(await background(1)).not.toBe('rgba(0, 0, 0, 0)');
    expect(await background(0)).toBe('rgba(0, 0, 0, 0)');
    expect(await background(2)).toBe('rgba(0, 0, 0, 0)');
    await expectNoHorizontalScroll(page);
  });
});
