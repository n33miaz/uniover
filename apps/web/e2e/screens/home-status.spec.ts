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

const strip = (page: Page) => page.locator('.chips li');
const stripTexts = async (page: Page) =>
  (await strip(page).allTextContents()).map((text) => text.trim());
const tvBadge = (page: Page) => page.locator('article[data-module="tv"] .badges');
const stateReads = () =>
  tv.requests.filter((request) => request.method === 'GET' && request.path === '/state').length;

function printPath(info: { project: { name: string } }, state: string, scheme: Scheme) {
  return `test-results/home-status/home-${state}-${info.project.name}-${scheme}.png`;
}

/** Entrega ao app, pelo fluxo, o evento do vigia no formato que o agente manda. */
const sendWatchdog = (page: Page, kind: string, severity: string) =>
  emitSse(page, 'tv.watchdog', {
    kind,
    severity,
    detail: '',
    attempts: 1,
    at: '2026-10-20T10:00:00Z',
  });

test.describe('Início: estado real da casa', () => {
  for (const scheme of SCHEMES) {
    test(`agente ligado no tema ${scheme}: selos, print e acessibilidade`, async ({
      page,
    }, info) => {
      await openHome(page, scheme);
      await expect(strip(page).first()).toHaveText('Agente ligado');
      expect(await stripTexts(page)).toEqual(['Agente ligado', 'Vigia sem dados']);
      await expect(strip(page).first()).toHaveClass(/\bok\b/);
      await expect(strip(page).nth(1)).not.toHaveClass(/\b(ok|warn)\b/);
      await expect(tvBadge(page)).toContainText('Pronto para usar');
      await settle(page);
      await expectNoHorizontalScroll(page);
      await screenshot(page, printPath(info, 'agent-on', scheme));
      expect(await smallTargets(page)).toEqual([]);
      await expectNoA11yViolations(page);
    });

    test(`agente desligado no tema ${scheme}: selos, print e acessibilidade`, async ({
      page,
    }, info) => {
      tv.state = { ...AGENT_OFF };
      await openHome(page, scheme);
      await expect(strip(page).first()).toHaveText('Agente desligado');
      expect(await stripTexts(page)).toEqual(['Agente desligado', 'Vigia sem dados']);
      await expect(strip(page).first()).toHaveClass(/\bwarn\b/);
      await expect(tvBadge(page)).toContainText('Sem agente em casa');
      await settle(page);
      await expectNoHorizontalScroll(page);
      await screenshot(page, printPath(info, 'agent-off', scheme));
      expect(await smallTargets(page)).toEqual([]);
      await expectNoA11yViolations(page);
    });

    test(`vigia em alerta e em ordem no tema ${scheme}: selos, print e acessibilidade`, async ({
      page,
    }, info) => {
      await openHome(page, scheme);
      await expect(strip(page).first()).toHaveText('Agente ligado');

      await sendWatchdog(page, 'repair_failed', 'error');
      await expect(strip(page).nth(1)).toHaveText('Vigia com aviso');
      await expect(strip(page).nth(1)).toHaveClass(/\bwarn\b/);
      await settle(page);
      await screenshot(page, printPath(info, 'watcher-alert', scheme));
      await expectNoA11yViolations(page);

      await sendWatchdog(page, 'repaired', 'info');
      await expect(strip(page).nth(1)).toHaveText('Vigia sem avisos');
      await expect(strip(page).nth(1)).toHaveClass(/\bok\b/);
      await expectNoA11yViolations(page);
    });

    test(`serviço fora do ar no tema ${scheme}: selos, print e acessibilidade`, async ({
      context,
      page,
    }, info) => {
      // A API não responde: a conexão é recusada.
      await context.route('**/api/v1/tv/state', (route) => route.abort('connectionrefused'));
      await openHome(page, scheme);
      await expect(page.getByText('Serviço fora do ar', { exact: true })).toBeVisible();
      expect(await stripTexts(page)).toEqual([
        'Agente sem dados',
        'Vigia sem dados',
        'Serviço fora do ar',
      ]);
      await expect(tvBadge(page)).not.toContainText('Pronto para usar');
      await settle(page);
      await screenshot(page, printPath(info, 'service-down', scheme));
      await expectNoA11yViolations(page);
    });
  }

  test('segue o agente em tempo real pelo fluxo, sem esperar a próxima leitura', async ({
    page,
  }) => {
    await openHome(page, 'light');
    await expect(strip(page).first()).toHaveText('Agente ligado');
    await emitSse(page, 'tv.state', AGENT_OFF);
    await expect(strip(page).first()).toHaveText('Agente desligado');
    await emitSse(page, 'tv.state', HOT_STATE);
    await expect(strip(page).first()).toHaveText('Agente ligado');
  });

  test('o fluxo só fica aberto com a Início na tela e a leitura volta com ela', async ({
    page,
  }) => {
    await openHome(page, 'light');
    await expect(strip(page).first()).toHaveText('Agente ligado');
    expect(await openStreams(page)).toBe(1);
    const reads = stateReads();
    expect(reads).toBeGreaterThanOrEqual(1);

    await page
      .getByRole('link', { name: /Ajustes/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { level: 2, name: 'Conta' })).toBeVisible();
    await expect.poll(() => openStreams(page)).toBe(0);

    tv.state = { ...AGENT_OFF };
    await page.getByRole('link', { name: /Início/ }).click();
    await expect(strip(page).first()).toHaveText('Agente desligado');
    expect(await openStreams(page)).toBe(1);
    expect(stateReads()).toBeGreaterThan(reads);
  });

  test('sem rede não consulta nem acusa erro, e ao voltar a rede lê de novo', async ({
    context,
    page,
  }) => {
    await openHome(page, 'light');
    await expect(strip(page).first()).toHaveText('Agente ligado');
    const reads = stateReads();

    await context.setOffline(true);
    await expect.poll(() => openStreams(page)).toBe(0);
    expect(await stripTexts(page)).toEqual(['Agente ligado', 'Vigia sem dados']);
    expect(stateReads()).toBe(reads);

    tv.state = { ...AGENT_OFF };
    await context.setOffline(false);
    await expect(strip(page).first()).toHaveText('Agente desligado');
    expect(await stripTexts(page)).not.toContain('Serviço fora do ar');
    expect(stateReads()).toBeGreaterThan(reads);
  });
});
