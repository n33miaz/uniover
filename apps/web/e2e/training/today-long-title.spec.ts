import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { expectNoA11yViolations, settle } from '../screens/screen-helpers';
import { installClock, openToday, stubDevice } from './support/today-pages';
import { SEED_EXERCISE_IDS } from './support/training-seed';
import { startTraining } from './support/training-pages';
import type { TrainingServer } from './support/training-server';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const LONG_NAME =
  'Treino de Peito, Ombros e Tríceps com Superséries e Cargas Progressivas para a Semana Toda';

function seedLongRoutine(server: TrainingServer): void {
  const at = '2026-10-02T10:00:00.0000000+00:00';
  server.seed('routines', [
    {
      id: '10000000-0000-4000-8000-0000000000aa',
      name: LONG_NAME,
      position: 0,
      active: true,
      note: null,
      items: [
        {
          id: '20000000-0000-4000-8000-0000000000aa',
          exerciseId: SEED_EXERCISE_IDS.bench,
          position: 0,
          targetSets: 3,
          repMin: 6,
          repMax: 10,
          restSeconds: 90,
          supersetGroup: null,
          note: null,
        },
      ],
      updatedAt: at,
      clientUpdatedAt: at,
      deleted: false,
    },
  ]);
}

test.describe('Hoje: nome de rotina longo', () => {
  test('o título fica numa linha com reticências, sem empurrar a engrenagem nem a tela', async ({
    page,
    context,
  }) => {
    await installClock(page);
    await stubDevice(page, {});
    const server = await startTraining(context, page, { routines: false });
    seedLongRoutine(server);
    await openToday(page, { history: false });

    const heading = page.locator('.routine').getByRole('heading', { name: LONG_NAME });
    await expect(heading).toBeVisible();
    // O nome inteiro continua no rótulo acessível; o que corta é só a aparência.
    await expect(heading).toHaveAttribute('aria-label', LONG_NAME);
    await expect(heading).toHaveCSS('white-space', 'nowrap');
    await expect(heading).toHaveCSS('text-overflow', 'ellipsis');

    // A engrenagem e o botão principal seguem inteiros dentro da tela (390 px no iPhone 12).
    const width = page.viewportSize()!.width;
    const gear = await page.getByRole('button', { name: 'Configurar Rotina' }).boundingBox();
    expect(gear!.x + gear!.width).toBeLessThanOrEqual(width);
    const start = await page.getByRole('button', { name: 'Iniciar Treino' }).boundingBox();
    expect(start!.x + start!.width).toBeLessThanOrEqual(width);
    expect(start!.y + start!.height).toBeLessThanOrEqual(page.viewportSize()!.height);

    await settle(page);
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
  });
});
