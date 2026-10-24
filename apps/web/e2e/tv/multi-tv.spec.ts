import { join } from 'node:path';
import { Page } from '@playwright/test';
import { GUEST, IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import {
  MockShortcut,
  MockTv,
  TvMock,
  installFakeEventSource,
  mockTvApi,
  sseUrls,
} from './tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints (o orquestrador aponta uma pasta); sem a variável, ficam em `test-results`. */
const SHOTS = process.env['TV_MULTI_SHOTS'] ?? 'test-results';

const ANDROID_CAPS = ['tv.remote', 'tv.kind.android', 'tv.adb'];
const SAMSUNG_CAPS = ['tv.remote', 'tv.kind.samsung'];

const CASA: MockTv = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Casa',
  isDefault: true,
  agentSlug: 'pc-casa',
  kind: 'android',
  online: true,
  capabilities: ANDROID_CAPS,
  state: {
    power: 'on',
    volume: 22,
    app: null,
    connection: 'hot',
    agentOnline: true,
    updatedAt: '2026-10-19T14:02:00Z',
  },
  shortcuts: [shortcut(1, 'Spotify')],
};
const RAPHAEL: MockTv = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Raphael',
  isDefault: false,
  agentSlug: 'pc-raphael',
  kind: 'samsung',
  online: true,
  capabilities: SAMSUNG_CAPS,
  state: {
    power: 'on',
    volume: 7,
    app: null,
    connection: 'hot',
    agentOnline: true,
    updatedAt: '2026-10-19T14:02:00Z',
  },
  shortcuts: [shortcut(1, 'Netflix')],
};

function shortcut(position: number, label: string): MockShortcut {
  return {
    id: `00000000-0000-4000-8000-0000000002${String(position).padStart(2, '0')}${label.length}`,
    position,
    package: `exemplo.${label.toLowerCase()}`,
    tvLabel: label,
    customLabel: null,
    enabled: true,
    installed: true,
  };
}

let identity: IdentityMock;
let tv: TvMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  tv = await mockTvApi(context, identity);
  await installFakeEventSource(page);
  identity.loggedIn = true;
});

/** O dono de volta à TV com as TVs do servidor dadas (uma cópia: cada teste muda as suas). */
function serve(list: readonly MockTv[]) {
  tv.tvs = list.map((item) => ({ ...item }));
}

async function openTv(page: Page, title: string) {
  await page.goto('/tv');
  await expect.poll(() => sseUrls(page).then((urls) => urls.length)).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await settle(page);
}

async function useScheme(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
  await settle(page);
}

async function shoot(page: Page, name: string, project: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await useScheme(page, scheme);
    await screenshot(page, join(SHOTS, `${name}-${scheme}-${project}.png`));
  }
}

async function expectSound(page: Page) {
  await expectNoHorizontalScroll(page);
  expect(await smallTargets(page)).toEqual([]);
  for (const scheme of ['light', 'dark'] as const) {
    await useScheme(page, scheme);
    await expectNoA11yViolations(page);
  }
}

const header = (page: Page) => page.locator('header.head');
const switcherButton = (page: Page) => header(page).locator('h1 button');
const switchDialog = (page: Page) => page.getByRole('dialog', { name: 'Escolher a TV' });
const chip = (page: Page, label: string) => page.locator(`.shortcut[aria-label="${label}"]`);
const menuDialog = (page: Page) => page.getByRole('dialog', { name: 'Mais opções' });

async function pickTv(page: Page, name: string) {
  await switcherButton(page).click();
  await expect(switchDialog(page)).toBeVisible();
  await switchDialog(page)
    .getByRole('button', { name: new RegExp(name) })
    .click();
  await expect(switchDialog(page)).toBeHidden();
}

test.describe('uma TV só', () => {
  test('nada muda: o nome continua abrindo Personalizar e a API nunca recebe tvId', async ({
    page,
  }) => {
    serve([CASA]);
    await openTv(page, 'TV');
    await expect(page.getByRole('button', { name: 'TV, personalizar' })).toBeVisible();
    await expect(header(page).locator('.chevron')).toHaveCount(0);
    expect(await sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await expect(chip(page, 'Spotify')).toBeVisible();
    expect(tv.requests.filter((r) => r.tvId !== null)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Teclado', exact: true })).toBeVisible();
  });

  test('com o servidor sem a lista de TVs (404) o app age como sempre', async ({ page }) => {
    tv.tvs = null;
    await openTv(page, 'TV');
    expect(await sseUrls(page)).toEqual(['/api/v1/tv/events']);
    expect(tv.requests.some((r) => r.path === '/tvs')).toBe(true);
    expect(tv.requests.filter((r) => r.tvId !== null)).toEqual([]);
  });
});

test.describe('duas TVs', () => {
  test('o título vira o seletor, e a folha lista as TVs com o estado e a TV em uso', async ({
    page,
  }, info) => {
    serve([CASA, { ...RAPHAEL, online: false }]);
    await openTv(page, 'Casa');
    const title = switcherButton(page);
    await expect(title).toHaveAccessibleName('Casa, trocar de TV');
    await expect(title.locator('.chevron')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shoot(page, 'seletor-fechado', info.project.name);

    await title.click();
    const dialog = switchDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('button.ui-row')).toHaveCount(2);
    await expect(dialog.getByRole('button', { name: /Casa/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(dialog.getByRole('button', { name: /Raphael/ })).not.toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(dialog.getByRole('button', { name: /Raphael/ })).toContainText('agente desligado');
    await settle(page);
    await shoot(page, 'seletor-aberto', info.project.name);
    await expectSound(page);
  });

  test('a folha fecha por Esc e pelo toque fora, e devolve o foco ao título', async ({ page }) => {
    serve([CASA, RAPHAEL]);
    await openTv(page, 'Casa');
    await switcherButton(page).click();
    await expect(switchDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(switchDialog(page)).toBeHidden();
    await expect(switcherButton(page)).toBeFocused();

    await switcherButton(page).click();
    await expect(switchDialog(page)).toBeVisible();
    await page.mouse.click(8, 8);
    await expect(switchDialog(page)).toBeHidden();
  });

  test('trocar de TV não mostra os atalhos da anterior na nova, nem por um instante', async ({
    page,
  }) => {
    serve([CASA, RAPHAEL]);
    await openTv(page, 'Casa');
    await expect(chip(page, 'Spotify')).toBeVisible();

    // A TV nova ainda não respondeu: o que se sabia da anterior já saiu da tela.
    let release!: () => void;
    tv.shortcutsGate = new Promise<void>((resolve) => (release = resolve));
    await pickTv(page, 'Raphael');
    await expect(page.getByRole('heading', { level: 1, name: 'Raphael' })).toBeVisible();
    await expect(chip(page, 'Spotify')).toHaveCount(0);
    await expect(chip(page, 'Netflix')).toHaveCount(0);

    release();
    tv.shortcutsGate = null;
    await expect(chip(page, 'Netflix')).toBeVisible();
    await expect(chip(page, 'Spotify')).toHaveCount(0);
    await expect(page.locator('[aria-label="Volume 7"]').first()).toBeVisible();

    // Os pedidos e o fluxo passam a ser os da TV nova.
    await expect.poll(() => sseUrls(page)).toContain(`/api/v1/tv/events?tvId=${RAPHAEL.id}`);
    expect(
      tv.requests.filter((r) => r.path === '/shortcuts' && r.tvId === RAPHAEL.id).length,
    ).toBeGreaterThan(0);

    // Voltar à primeira mostra só a dela.
    await pickTv(page, 'Casa');
    await expect(chip(page, 'Spotify')).toBeVisible();
    await expect(chip(page, 'Netflix')).toHaveCount(0);
  });

  test('a TV escolhida fica guardada para a próxima vez, e a preferência é de cada TV', async ({
    page,
  }) => {
    serve([CASA, RAPHAEL]);
    await openTv(page, 'Casa');
    await pickTv(page, 'Raphael');
    await expect(page.getByRole('heading', { level: 1, name: 'Raphael' })).toBeVisible();

    // O apelido de uma TV não vale para a outra (as preferências são por conta e por TV).
    await menuDialogOpen(page);
    await menuDialog(page).getByRole('button', { name: 'Personalizar', exact: true }).click();
    const sheet = page.locator('app-tv-customize-sheet dialog');
    await sheet.getByLabel('Nome da TV').fill('Quarto');
    await sheet.getByRole('button', { name: 'Concluir' }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Quarto' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Quarto' })).toBeVisible();
    await expect.poll(() => sseUrls(page)).toContain(`/api/v1/tv/events?tvId=${RAPHAEL.id}`);

    await pickTv(page, 'Casa');
    await expect(page.getByRole('heading', { level: 1, name: 'Casa' })).toBeVisible();
  });

  test('se a TV guardada sumiu, cai na padrão sem erro', async ({ page }) => {
    serve([CASA, RAPHAEL]);
    await openTv(page, 'Casa');
    await pickTv(page, 'Raphael');
    await expect(page.getByRole('heading', { level: 1, name: 'Raphael' })).toBeVisible();

    // O administrador removeu a TV do Raphael: a lista nova só tem a padrão.
    tv.tvs = tv.tvs!.filter((item) => item.id !== RAPHAEL.id);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
    await expect(chip(page, 'Spotify')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

async function menuDialogOpen(page: Page) {
  await header(page).getByRole('button', { name: 'Mais opções' }).click();
  await expect(menuDialog(page)).toBeVisible();
}

test.describe('capacidades da TV', () => {
  test('uma Samsung não tem teclado nem limpeza, e uma Android tem os dois', async ({ page }) => {
    serve([CASA, RAPHAEL]);
    await openTv(page, 'Casa');
    await expect(page.getByRole('button', { name: 'Teclado', exact: true })).toBeVisible();
    await menuDialogOpen(page);
    await menuDialog(page).getByRole('button', { name: 'Apps da TV', exact: true }).click();
    const apps = page.getByRole('dialog', { name: 'Apps da TV' });
    await expect(apps.getByRole('button', { name: 'Limpar a TV' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(apps).toBeHidden();

    await pickTv(page, 'Raphael');
    await expect(page.getByRole('heading', { level: 1, name: 'Raphael' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Teclado', exact: true })).toHaveCount(0);
    // Sete botões redondos, sem sobra no layout.
    await expect(page.locator('.round-grid .round')).toHaveCount(7);
    await expectNoHorizontalScroll(page);

    // Os apps seguem (a Samsung os abre pelo canal dela); o que some é a limpeza.
    await menuDialogOpen(page);
    await menuDialog(page).getByRole('button', { name: 'Apps da TV', exact: true }).click();
    await expect(apps).toBeVisible();
    await expect(apps.getByRole('button', { name: 'Limpar a TV' })).toHaveCount(0);
    await expect(apps.getByRole('button', { name: 'Atualizar lista' })).toBeVisible();
  });

  test('com o agente desligado a TV não perde botões (a API não sabe o que ele faz)', async ({
    page,
  }) => {
    serve([{ ...CASA, online: false, kind: null, capabilities: [] }, RAPHAEL]);
    await openTv(page, 'Casa');
    await expect(page.getByRole('button', { name: 'Teclado', exact: true })).toBeVisible();
  });
});

test.describe('conta que só vê a TV dela', () => {
  test('com uma TV só visível não há seletor, nem tvId, e vê o estado da dela', async ({
    page,
  }) => {
    identity.guests.push({
      id: '00000000-0000-4000-8000-000000000071',
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:tv', 'tv:control', 'tv:launch'],
    });
    identity.role = 'guest';
    serve([CASA, RAPHAEL]);
    tv.members[RAPHAEL.id] = ['00000000-0000-4000-8000-000000000071'];

    await openTv(page, 'TV');
    await expect(header(page).locator('.chevron')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'TV, personalizar' })).toBeVisible();
    expect(await sseUrls(page)).toEqual(['/api/v1/tv/events']);
    // É a TV do Raphael (volume 7, Netflix, sem teclado), não a padrão.
    await expect(page.locator('[aria-label="Volume 7"]').first()).toBeVisible();
    await expect(chip(page, 'Netflix')).toBeVisible();
    await expect(chip(page, 'Spotify')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Teclado', exact: true })).toHaveCount(0);
    expect(tv.requests.filter((r) => r.tvId !== null)).toEqual([]);
    expect(tv.denied).toEqual([]);
    await expectSound(page);
  });

  test('uma conta que está em duas TVs escolhe entre as duas, e nunca vê as que não são dela', async ({
    page,
  }) => {
    const OTHER: MockTv = {
      ...RAPHAEL,
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Garagem',
      agentSlug: 'pc-garagem',
    };
    identity.guests.push({
      id: '00000000-0000-4000-8000-000000000072',
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:tv', 'tv:control'],
    });
    identity.role = 'guest';
    serve([CASA, RAPHAEL, OTHER]);
    tv.members[RAPHAEL.id] = ['00000000-0000-4000-8000-000000000072'];
    tv.members[OTHER.id] = ['00000000-0000-4000-8000-000000000072'];

    await openTv(page, 'Garagem');
    await switcherButton(page).click();
    const dialog = switchDialog(page);
    await expect(dialog.locator('button.ui-row')).toHaveCount(2);
    await expect(dialog.getByRole('button', { name: /Casa/ })).toHaveCount(0);
  });
});
