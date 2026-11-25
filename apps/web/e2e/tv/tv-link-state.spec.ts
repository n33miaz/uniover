import { Page } from '@playwright/test';
import { IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { expectNoA11yViolations, settle } from '../screens/screen-helpers';
import {
  HOT_STATE,
  MockTv,
  MockTvState,
  TvMock,
  emitSse,
  installFakeEventSource,
  mockTvApi,
  sseUrls,
} from './tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const linked = (state: string, extra: Partial<MockTvState> = {}): MockTvState => ({
  ...HOT_STATE,
  ...extra,
  link: { version: 1, state },
});

let identity: IdentityMock;
let tv: TvMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  tv = await mockTvApi(context, identity);
  tv.state = linked('ready');
  await installFakeEventSource(page);
});

const line = (page: Page) => page.locator('.link-state');

async function openTv(page: Page) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/tv');
  await expect.poll(() => sseUrls(page)).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeVisible();
}

/** Espera a resposta atrasada chegar à página e a tela ter tido tempo de (não) mudar com ela. */
async function afterStateResponse(page: Page, trigger: () => unknown) {
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/tv/state');
  await trigger();
  await (await response).finished();
  await settle(page);
}

test('diz em português o elo lido da API e acompanha o fluxo em tempo real', async ({ page }) => {
  await openTv(page);
  await expect(line(page)).toHaveText('Tudo pronto');

  const cases: [string, Partial<MockTvState>, string][] = [
    [
      'pc_offline',
      { agentOnline: false, connection: 'disconnected' },
      'PC desligado ou sem conexão',
    ],
    ['tv_off', { power: 'off' }, 'TV desligada'],
    ['tv_standby', { connection: 'waking' }, 'TV em standby'],
    ['tv_sleep', {}, 'TV no Modo Dormir'],
    ['tv_unresponsive', { connection: 'disconnected' }, 'A TV não responde ao PC'],
    ['algo_novo', {}, 'Estado da TV sem confirmação'],
    ['ready', {}, 'Tudo pronto'],
  ];
  for (const [state, extra, text] of cases) {
    await emitSse(page, 'tv.state', linked(state, extra));
    await expect(line(page)).toHaveText(text);
    await expectNoHorizontalScroll(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight),
      `${state}: sem rolagem vertical`,
    ).toBeLessThanOrEqual(0);
  }

  await expect(page.getByText('Direto', { exact: true })).toHaveCount(0);
  await settle(page);
  await expectNoA11yViolations(page);
});

test('uma leitura que responde depois do fluxo não apaga o estado mais novo', async ({ page }) => {
  let release!: () => void;
  tv.stateGate = new Promise((resolve) => (release = resolve));
  await openTv(page);
  await expect(line(page)).toHaveText('Estado da TV sem confirmação');

  await emitSse(page, 'tv.state', linked('tv_off', { power: 'off' }));
  await expect(line(page)).toHaveText('TV desligada');

  // A leitura segurada responde agora com o que valia antes do evento.
  await afterStateResponse(page, release);
  await expect(line(page)).toHaveText('TV desligada');
});

test('uma leitura que falha mantém o último estado', async ({ context, page }) => {
  await openTv(page);
  await expect(line(page)).toHaveText('Tudo pronto');

  await context.route('**/api/v1/tv/state', (route) => route.fulfill({ status: 500 }));
  await afterStateResponse(page, () =>
    page.evaluate(() => window.dispatchEvent(new Event('online'))),
  );
  await expect(line(page)).toHaveText('Tudo pronto');
});

test('trocar de TV não mostra o estado da anterior', async ({ page }) => {
  const make = (id: string, name: string, isDefault: boolean, state: MockTvState): MockTv => ({
    id,
    name,
    isDefault,
    agentSlug: `pc-${name.toLowerCase()}`,
    kind: 'android',
    online: true,
    capabilities: ['tv.remote', 'tv.kind.android', 'tv.adb'],
    state,
  });
  tv.tvs = [
    make('11111111-1111-4111-8111-111111111111', 'Casa', true, linked('ready')),
    make(
      '22222222-2222-4222-8222-222222222222',
      'Quarto',
      false,
      linked('tv_off', { power: 'off' }),
    ),
  ];
  await openTv(page);
  await expect(line(page)).toHaveText('Tudo pronto');

  let release!: () => void;
  tv.stateGate = new Promise((resolve) => (release = resolve));
  await page.getByRole('button', { name: 'Casa, trocar de TV' }).click();
  await page.locator('app-tv-switcher button.ui-row', { hasText: 'Quarto' }).click();
  await expect(line(page)).toHaveText('Estado da TV sem confirmação');

  release();
  await expect(line(page)).toHaveText('TV desligada');
});
