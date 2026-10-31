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

/** A bolinha é sempre um círculo (largura igual à altura e raio de pelo menos metade), em qualquer estado. */
async function expectCircle(page: Page) {
  const shape = await indicator(page).evaluate((dot) => {
    const style = getComputedStyle(dot);
    const radius = style.borderTopLeftRadius;
    const { width, height } = dot.getBoundingClientRect();
    const half = radius.endsWith('%') ? parseFloat(radius) >= 50 : parseFloat(radius) >= width / 2;
    return { width, height, half };
  });
  expect(shape.width).toBeGreaterThan(0);
  expect(shape.width).toBe(shape.height);
  expect(shape.half).toBe(true);
}
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
      await expectCircle(page);

      const tvCard = page.locator('article[data-module="tv"]');
      await expect(tvCard.locator('app-home-soon-badge')).toHaveCount(0);
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
      await expectCircle(page);
      await settle(page);
      await expectNoHorizontalScroll(page);
      await screenshot(page, printPath(info, 'agent-off', scheme));
      expect(await smallTargets(page)).toEqual([]);
      await expectNoA11yViolations(page);
    });
  }

  test('sem resposta, a bolinha avisa sem texto visível', async ({ context, page }) => {
    await context.route('**/api/v1/tv/state', (route) => route.abort('connectionrefused'));
    await openHome(page, 'light');
    await expect(indicator(page)).toHaveAttribute('aria-label', 'Agente sem resposta');
    await expect(indicator(page)).toHaveAttribute('title', 'Agente sem resposta');
    await expect(indicator(page)).toHaveClass(/\bwarn\b/);
    await expectCircle(page);
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
    await page.getByRole('button', { name: /Início/ }).click();
    await expect(indicator(page)).toHaveAttribute('aria-label', 'Agente desligado');
    expect(await openStreams(page)).toBe(1);
    expect(stateReads()).toBeGreaterThan(reads);
  });

  test('o convidado com a TV liberada vê a bolinha do agente DELE', async ({ page }) => {
    identity.guests.push({
      id: '00000000-0000-4000-8000-000000000061',
      displayName: 'Raphael',
      email: 'raphael@exemplo.com',
      password: 'senha-do-raphael-123',
      createdAt: '2026-10-21T15:00:00Z',
      disabledAt: null,
      permissions: ['module:tv', 'tv:control', 'module:training'],
    });
    identity.role = 'guest';
    tv.state = { ...HOT_STATE, agentLinked: true };
    await page.goto('/');
    await expect(indicator(page)).toHaveAttribute('aria-label', 'Agente ligado');
    tv.state = { ...AGENT_OFF, agentLinked: true };
    await emitSse(page, 'tv.state', tv.state);
    await expect(indicator(page)).toHaveAttribute('aria-label', 'Agente desligado');
  });

  test('sem agente vinculado à conta não há bolinha', async ({ page }) => {
    tv.state = { ...AGENT_OFF, agentLinked: false };
    await openHome(page, 'light');
    await expect(indicator(page)).toHaveCount(0);
  });

  test('enquanto a leitura demora a bolinha pulsa suave, e com movimento reduzido fica parada', async ({
    page,
  }) => {
    let release!: () => void;
    tv.stateGate = new Promise<void>((resolve) => (release = resolve));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    await expect(indicator(page)).toHaveAttribute('aria-label', 'Conectando ao agente', {
      timeout: 5000,
    });
    const animated = await indicator(page).evaluate((dot) => getComputedStyle(dot).animationName);
    expect(animated).not.toBe('none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const still = await indicator(page).evaluate((dot) => getComputedStyle(dot).animationName);
    expect(still).toBe('none');
    release();
    await expect(indicator(page)).toHaveAttribute('aria-label', 'Agente ligado');
  });
});
