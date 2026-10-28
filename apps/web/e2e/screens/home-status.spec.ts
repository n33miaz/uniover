import { Page } from '@playwright/test';
import { IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import {
  HOT_STATE,
  MockTvState,
  TvMock,
  emitSse,
  installFakeEventSource,
  mockTvApi,
  openStreams,
  sseUrls,
} from '../tv/tv-mock';
import { expectNoA11yViolations, settle, smallTargets } from './screen-helpers';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

const AGENT_OFF: MockTvState = {
  power: 'unknown',
  volume: null,
  app: null,
  connection: 'disconnected',
  agentOnline: false,
  updatedAt: HOT_STATE.updatedAt,
};

let identity: IdentityMock;
let tv: TvMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  tv = await mockTvApi(context, identity);
  await installFakeEventSource(page);
});

async function openHome(page: Page, scheme: Scheme) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    OWNER.displayName.split(' ')[0],
  );
  // O fluxo abre junto da primeira leitura do estado.
  await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
}

const indicator = (page: Page) => page.locator('.agent-status');
const stateReads = () =>
  tv.requests.filter((request) => request.method === 'GET' && request.path === '/state').length;

function printPath(info: { project: { name: string } }, state: string, scheme: Scheme) {
  return `test-results/home-status/home-${state}-${info.project.name}-${scheme}.png`;
}

test.describe('Início: estado real da casa', () => {
  for (const scheme of SCHEMES) {
    test(`agente ligado no tema ${scheme}: bolinha, print e acessibilidade`, async ({
      page,
    }, info) => {
      await openHome(page, scheme);
      await expect(indicator(page)).toHaveAttribute('aria-label', 'Agente ligado');
      await expect(indicator(page)).toHaveAttribute('title', 'Agente ligado');
      await expect(indicator(page)).toHaveClass(/\bok\b/);

      const tvCard = page.locator('article[data-module="tv"]');
      await expect(tvCard.locator('.badges')).toHaveText('');
      await expect(tvCard.locator('.desc, .card-action')).toHaveCount(0);
      await expect(tvCard.locator('a.card-link')).toHaveAttribute(
        'aria-label',
        'TV: Abrir controle',
      );
      await expect(page.locator('li.widget:has(article[data-module="tv"])')).not.toHaveClass(
        /\bwide\b/,
      );
      await expect(page.locator('li.widget:has(article[data-module="training"])')).not.toHaveClass(
        /\bwide\b/,
      );
      await settle(page);
      await expectNoHorizontalScroll(page);
      await screenshot(page, printPath(info, 'agent-on', scheme));
      expect(await smallTargets(page)).toEqual([]);
      await expectNoA11yViolations(page);
    });

    test(`agente desligado no tema ${scheme}: bolinha, print e acessibilidade`, async ({
      page,
    }, info) => {
      tv.state = { ...AGENT_OFF };
      await openHome(page, scheme);
      await expect(indicator(page)).toHaveAttribute('aria-label', 'Agente desligado');
      await expect(indicator(page)).toHaveAttribute('title', 'Agente desligado');
      await expect(indicator(page)).toHaveClass(/\bwarn\b/);
      await settle(page);
      await expectNoHorizontalScroll(page);
      await screenshot(page, printPath(info, 'agent-off', scheme));
      expect(await smallTargets(page)).toEqual([]);
      await expectNoA11yViolations(page);
    });
  }

  test('sem dados, a bolinha usa um estado neutro com texto acessível', async ({
    context,
    page,
  }) => {
    await context.route('**/api/v1/tv/state', (route) => route.abort('connectionrefused'));
    await openHome(page, 'light');
    await expect(indicator(page)).toHaveAttribute('aria-label', 'Agente sem dados');
    await expect(indicator(page)).toHaveAttribute('title', 'Agente sem dados');
    await expect(indicator(page)).toHaveClass(/\bneutral\b/);
    await expect(page.locator('.chips')).toHaveCount(0);
  });

  test('segue o agente em tempo real pelo fluxo, sem exibir o vigia', async ({ page }) => {
    await openHome(page, 'light');
    await expect(indicator(page)).toHaveAttribute('aria-label', 'Agente ligado');
    await emitSse(page, 'tv.state', AGENT_OFF);
    await expect(indicator(page)).toHaveAttribute('aria-label', 'Agente desligado');
    await emitSse(page, 'tv.state', HOT_STATE);
    await expect(indicator(page)).toHaveAttribute('aria-label', 'Agente ligado');
    await expect(page.getByText(/Vigia/)).toHaveCount(0);
  });

  test('o fluxo só fica aberto com a Início na tela e a leitura volta com ela', async ({
    page,
  }) => {
    await openHome(page, 'light');
    await expect(indicator(page)).toHaveAttribute('aria-label', 'Agente ligado');
    expect(await openStreams(page)).toBe(1);
    const reads = stateReads();
    expect(reads).toBeGreaterThanOrEqual(1);

    await page
      .getByRole('link', { name: /Configurações/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { level: 2, name: 'Você' })).toBeVisible();
    await expect.poll(() => openStreams(page)).toBe(0);

    tv.state = { ...AGENT_OFF };
    await page.getByRole('link', { name: /Início/ }).click();
    await expect(indicator(page)).toHaveAttribute('aria-label', 'Agente desligado');
    expect(await openStreams(page)).toBe(1);
    expect(stateReads()).toBeGreaterThan(reads);
  });
});
