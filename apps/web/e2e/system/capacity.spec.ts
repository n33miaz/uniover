import { Page, TestInfo } from '@playwright/test';
import { IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { SystemMock, defaultCapacity, mockSystemApi } from './system-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

let identity: IdentityMock;
let system: SystemMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  await mockTvApi(context, identity);
  // Depois do mock da TV: a rota registrada por último vence, e a configuração mora sob o mesmo prefixo.
  system = await mockSystemApi(context, identity);
  await installFakeEventSource(page);
});

/** Abre Sistema e espera o cartão de Capacidade (ou o seu erro) aparecer. */
async function open(page: Page, scheme: Scheme = 'light') {
  // Movimento reduzido: as animações de entrada saem do caminho e o axe mede as cores finais.
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.goto('/ajustes/sistema');
  await expect(page.getByRole('heading', { level: 1, name: 'Sistema' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Capacidade' })).toBeVisible();
}

const card = (page: Page) => page.locator('app-system-capacity-section');
const meters = (page: Page) => card(page).locator('.meter');

/** O roteiro de toda tela: sem rolagem de lado, print, alvos de 44 px e o axe sem nenhuma violação. */
async function check(page: Page, info: TestInfo, name: string, scheme: Scheme) {
  await settle(page);
  await expectNoHorizontalScroll(page);
  await screenshot(page, `test-results/capacity/${name}-${info.project.name}-${scheme}.png`, {
    fullPage: true,
  });
  expect(await smallTargets(page)).toEqual([]);
  await expectNoA11yViolations(page);
}

test.describe('Configurações > Sistema > Capacidade', () => {
  for (const scheme of SCHEMES) {
    test(`mostra banco, memória e horas do mês com a faixa e o rótulo Estimado, no tema ${scheme}`, async ({
      page,
    }, info) => {
      await open(page, scheme);

      await expect(meters(page)).toHaveCount(3);
      await expect(meters(page).nth(0)).toContainText('Banco');
      await expect(meters(page).nth(0)).toContainText('14,7 MB de 1 GB');
      await expect(meters(page).nth(0)).toContainText('1,4% · Folga');
      await expect(meters(page).nth(0)).toHaveAttribute('data-band', 'green');
      await expect(meters(page).nth(1)).toContainText('180 MB de 512 MB');
      await expect(meters(page).nth(2)).toContainText('612 h de 750 h');
      await expect(meters(page).nth(2)).toContainText('Crítico');
      await expect(meters(page).nth(2)).toHaveAttribute('data-band', 'red');
      // Todas as três leituras do cartão são estimativas ou limites de nota: cada uma diz isso.
      await expect(card(page).locator('.meter .tag')).toHaveText([
        'Estimado',
        'Estimado',
        'Estimado',
      ]);
      await expect(card(page)).toContainText('Não medido');
      await expect(card(page).locator('.tables li').first()).toContainText('tv.command_audit');
      await check(page, info, 'capacity', scheme);
    });
  }

  test('mostra a tendência e quando o banco chega a 50% e 80%', async ({ page }) => {
    await open(page);

    await expect(card(page).locator('svg.spark polyline')).toBeVisible();
    await expect(card(page).locator('.rate')).toContainText('por dia');
    await expect(card(page).locator('.when dd')).toHaveText(['Mais de 2 anos', 'Mais de 2 anos']);
  });

  test('com poucas amostras pede mais dias em vez de inventar uma tendência', async ({ page }) => {
    system.capacity = {
      ...defaultCapacity(),
      growth: {
        points: [{ day: '2026-10-31', bytes: 15_400_000 }],
        bytesPerDay: null,
        daysToAmber: null,
        daysToRed: null,
        state: 'few',
      },
    };
    await open(page);

    await expect(card(page).locator('.few')).toContainText('Poucos dados');
    await expect(card(page).locator('svg.spark')).toHaveCount(0);
    await expect(card(page)).not.toContainText('Chega a 50%');
  });

  test('avisa quando passou de 80% e o aviso some ao dispensar', async ({ page }, info) => {
    system.capacity = {
      ...defaultCapacity(),
      alerts: [
        { id: 'a1', metric: 'hours', percent: 81, detectedAt: '2026-10-31T09:00:00Z' },
        { id: 'a2', metric: 'database', percent: 85, detectedAt: '2026-10-31T09:00:00Z' },
      ],
    };
    await open(page);

    const alert = card(page).locator('.alert');
    await expect(alert).toContainText('Passou de 80%');
    await expect(alert).toContainText('Horas do Mês, Banco');
    await check(page, info, 'capacity-alert', 'light');

    await alert.getByRole('button', { name: 'Dispensar' }).click();
    await expect(alert).toHaveCount(0);
    expect(system.capacityDismissals).toBe(1);
  });

  test('mostra o erro quando a leitura falha, sem esconder o resto da tela', async ({ page }) => {
    system.capacity = null;
    await open(page);

    await expect(card(page).getByRole('alert')).toContainText(
      'Não foi possível carregar a capacidade.',
    );
    await expect(page.getByRole('heading', { level: 2, name: 'Saúde' })).toBeVisible();
  });
});
