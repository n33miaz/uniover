import { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { settle } from '../screens/screen-helpers';
import { SEED_EXERCISE_IDS } from './support/training-seed';
import { seedPastWorkout } from './support/today-seed';
import { stubDevice } from './support/today-pages';
import { countRows, expectSynced, openTraining, startTraining } from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
// O fuso é fixo: o dia da semana vem do relógio do aparelho, e o teste precisa saber que dia é.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo' });

const DAY = 86_400_000;

const item = (exerciseSlug: string) => ({
  exerciseSlug,
  targetSets: 2,
  repMin: 8,
  repMax: 12,
  restSeconds: 60,
  supersetGroup: null,
});

/** Um programa seg/ter/qua: dá a linha "Programa da Semana" e uma rotina para segunda. */
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
function mondayNoon(): Date {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() - 1);
  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() - 1);
  return new Date(`${day.toISOString().slice(0, 10)}T12:00:00-03:00`);
}

/** A caixa de um elemento na tela, ou falha dizendo qual não está lá. */
async function box(page: Page, selector: string) {
  const found = await page.locator(selector).first().boundingBox();
  expect(found, `${selector} precisa estar na tela`).not.toBeNull();
  return found!;
}

test.describe('Hoje: a primeira tela', () => {
  test('o cartão do dia, os três totais e os dois atalhos cabem acima da barra de baixo, sem rolar', async ({
    page,
    context,
  }) => {
    const monday = mondayNoon();
    await page.clock.install({ time: monday });
    await stubDevice(page, {});
    const server = await startTraining(context, page, { routines: false });
    server.templates = WEEK_PROGRAM;
    // O treino de ontem (domingo, para o relógio da página) é o que o atalho "Treino de Ontem" abre.
    seedPastWorkout(server, 7, Date.now() - (monday.getTime() - DAY), [
      { exerciseId: SEED_EXERCISE_IDS.bench, weightKg: 40, reps: 10 },
    ]);
    await openTraining(page, '/treino');
    await expect.poll(() => countRows(page, 'exercises')).toBeGreaterThan(0);
    await page
      .locator('app-program-suggestion')
      .getByRole('button', { name: /Divisão de teste/ })
      .click();
    await expect(
      page.locator('.routine').getByRole('heading', { name: 'Segunda · Peito' }),
    ).toBeVisible();
    await expect(page.locator('.links').getByText('Treino de Ontem')).toBeVisible();
    await expect(page.locator('.links').getByText('Programa da Semana')).toBeVisible();
    // Escolher o programa grava na fila: com o aparelho em dia a faixa de sincronização some e a tela fica no repouso.
    await expectSynced(page, { timeout: 20_000 });
    await settle(page);

    const view = page.viewportSize()!;
    // A barra de baixo cobre o pé da tela: o conteúdo precisa terminar antes dela.
    const tabs = await box(page, 'app-tab-bar');
    const floor = Math.min(tabs.y, view.height);
    const bottomOf = async (selector: string) => {
      const found = await box(page, selector);
      return found.y + found.height;
    };
    // Soft: se mais de um passar do limite, a falha mostra todos de uma vez (o que ajuda a ajustar a densidade).
    const blocks: [string, string][] = [
      ['fim do cartão da rotina', '.routine'],
      ['fim dos três totais da semana', '.week .stats'],
      ['fim do cartão da semana', '.week'],
      ['fim de "Programa da Semana"', '.links li:nth-child(1)'],
      ['fim de "Treino de Ontem"', '.links li:nth-child(2)'],
    ];
    // Com DUMP_FIRST_SCREEN=1 a falha traz todas as medidas (para ajustar a densidade).
    if (process.env['DUMP_FIRST_SCREEN']) {
      const all = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll(
            '.date, .routine, .routine-top, .routine-name, .meta, .go, .routine-toggle, .week, .week-head, .week-days, .week-bottom, .stats, .links li, .actions',
          ),
        ).map((node) => {
          const r = node.getBoundingClientRect();
          return `${node.className.toString().split(' ')[0] || node.tagName} y=${r.y.toFixed(1)} h=${r.height.toFixed(1)} bottom=${(r.y + r.height).toFixed(1)}`;
        }),
      );
      expect(all.join('\n'), `floor=${floor}`).toBe('');
    }
    for (const [label, selector] of blocks) {
      expect
        .soft(await bottomOf(selector), `${label} (limite ${floor})`)
        .toBeLessThanOrEqual(floor);
    }
    expect(await page.evaluate(() => window.scrollY), 'a tela não rolou').toBe(0);

    // A data fica colada no começo do conteúdo, sem o vão que sobrava embaixo do cabeçalho.
    const header = await box(page, 'app-page-top-bar');
    const date = await box(page, '.date');
    expect(
      date.y - (header.y + header.height),
      'vão entre o cabeçalho e a data',
    ).toBeLessThanOrEqual(28);

    // Os alvos de toque continuam com 44 px.
    for (const selector of [
      '.routine-settings',
      '.routine-toggle',
      '.week-head .nav-button',
      '.calendar-link',
      '.links li:nth-child(1) .ui-row',
      '.links li:nth-child(2) .ui-row',
    ]) {
      const target = await box(page, selector);
      expect(target.height, `altura de ${selector}`).toBeGreaterThanOrEqual(43.5);
    }
  });
});
