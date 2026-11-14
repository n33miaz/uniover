import { join } from 'node:path';
import { Page } from '@playwright/test';
import { GUEST, IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { MockTv, TvMock, emitSse, installFakeEventSource, mockTvApi, sseUrls } from './tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker. Nenhuma chamada sai
// para uma TV de verdade: o agente e a TV são o mock.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints (o orquestrador aponta uma pasta); sem a variável, ficam em `test-results`. */
const SHOTS = process.env['TV_SETTINGS_SHOTS'] ?? 'test-results';

const ANDROID: MockTv = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'TV',
  isDefault: true,
  agentSlug: 'pc-casa',
  kind: 'android',
  online: true,
  capabilities: ['tv.remote', 'tv.kind.android', 'tv.adb', 'tv.settings.open.v1', 'tv.key.INPUT'],
};

const SAMSUNG: MockTv = {
  ...ANDROID,
  kind: 'samsung',
  capabilities: ['tv.remote', 'tv.kind.samsung', 'tv.key.INPUT'],
};

let identity: IdentityMock;
let tv: TvMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  tv = await mockTvApi(context, identity);
  await installFakeEventSource(page);
});

async function signIn(page: Page) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function showTv(page: Page) {
  await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
  await emitSse(page, 'tv.state', tv.state);
  await emitSse(page, 'tv.shortcuts', tv.shortcuts);
  await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
  await settle(page);
}

/** O dono na tela da TV, com a TV do servidor dada (a lista de TVs é o que diz o que o agente declarou). */
async function openTv(page: Page, served: MockTv) {
  tv.tvs = [{ ...served }];
  await signIn(page);
  await page.goto('/tv');
  await showTv(page);
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeVisible();
}

const menuButton = (page: Page) =>
  page.locator('.tv > header.head').getByRole('button', { name: 'Mais opções' });
const menuDialog = (page: Page) => page.getByRole('dialog', { name: 'Mais opções' });

async function openMenu(page: Page) {
  await menuButton(page).click();
  await expect(menuDialog(page)).toBeVisible();
  await settle(page);
}

/** Sem axe, sem alvo de toque pequeno e sem rolagem horizontal, nos dois temas. */
async function expectSound(page: Page) {
  await expectNoHorizontalScroll(page);
  expect(await smallTargets(page)).toEqual([]);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await settle(page);
    await expectNoA11yViolations(page);
  }
}

test.describe('Wi-Fi, Configurações e Entradas no menu', () => {
  test('numa Android TV, cada linha só age no toque, fecha o menu e avisa', async ({
    page,
  }, info) => {
    await openTv(page, ANDROID);
    expect(tv.settingsScreens(), 'abrir a tela da TV não manda nada sozinho').toEqual([]);

    await openMenu(page);
    const menu = menuDialog(page);
    for (const name of ['Wi-Fi da TV', 'Configurações da TV', 'Entradas']) {
      await expect(menu.getByRole('button', { name, exact: true })).toBeVisible();
    }
    // Os guias moram atrás da linha Ajuda.
    await expect(menu.getByRole('button', { name: 'Ajuda', exact: true })).toBeVisible();
    expect(tv.settingsScreens(), 'só ver o menu não manda nada').toEqual([]);
    await screenshot(page, join(SHOTS, `menu-com-acoes-${info.project.name}.png`));
    await expectSound(page);

    await menu.getByRole('button', { name: 'Wi-Fi da TV', exact: true }).click();
    await expect(menuDialog(page)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Rede aberta na TV.' })).toBeVisible();
    expect(tv.settingsScreens()).toEqual(['WIFI']);

    await openMenu(page);
    await menuDialog(page)
      .getByRole('button', { name: 'Configurações da TV', exact: true })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Configurações abertas na TV.' }),
    ).toBeVisible();
    expect(tv.settingsScreens()).toEqual(['WIFI', 'SETTINGS']);

    // Entradas é a mesma tecla de fonte do controle: nenhuma rota nova.
    await openMenu(page);
    await menuDialog(page).getByRole('button', { name: 'Entradas', exact: true }).click();
    await expect.poll(() => tv.keysSent()).toContain('INPUT');
    expect(tv.settingsScreens()).toEqual(['WIFI', 'SETTINGS']);
    expect(tv.denied).toEqual([]);
  });

  test('numa Samsung só há Entradas: Wi-Fi e Configurações da TV nem aparecem', async ({
    page,
  }) => {
    await openTv(page, SAMSUNG);
    await openMenu(page);
    const menu = menuDialog(page);
    await expect(menu.getByRole('button', { name: 'Wi-Fi da TV', exact: true })).toHaveCount(0);
    await expect(
      menu.getByRole('button', { name: 'Configurações da TV', exact: true }),
    ).toHaveCount(0);
    await expect(menu.getByRole('button', { name: 'Entradas', exact: true })).toBeVisible();
    expect(tv.settingsScreens()).toEqual([]);
  });

  test('com o agente que não abre a tela, o aviso diz isso e nada se repete', async ({ page }) => {
    await openTv(page, ANDROID);
    tv.settingsAnswer = 'unsupported';
    await openMenu(page);
    await menuDialog(page).getByRole('button', { name: 'Wi-Fi da TV', exact: true }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Esta TV não abre essa tela pelo app.' }),
    ).toBeVisible();
    expect(tv.settingsScreens()).toEqual(['WIFI']);
  });

  test('uma conta convidada com o controle também abre a tela da TV', async ({ page }) => {
    identity.guests.push({
      id: '00000000-0000-4000-8000-000000000061',
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:tv', 'tv:control'],
    });
    identity.role = 'guest';
    identity.loggedIn = true;
    tv.tvs = [{ ...ANDROID }];
    await page.goto('/tv');
    await showTv(page);
    await openMenu(page);
    await menuDialog(page).getByRole('button', { name: 'Wi-Fi da TV', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Rede aberta na TV.' })).toBeVisible();
    expect(tv.settingsScreens()).toEqual(['WIFI']);
    expect(tv.denied).toEqual([]);
  });
});

test.describe('Se a internet cair', () => {
  test('a Ajuda do menu leva ao passo a passo, que é só texto e volta ao controle', async ({
    page,
  }, info) => {
    await openTv(page, ANDROID);
    await openMenu(page);
    await menuDialog(page).getByRole('button', { name: 'Ajuda', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Ajuda' })
      .getByRole('link', { name: 'Se a internet cair' })
      .click();
    await expect(page).toHaveURL(/\/tv\/internet$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Só a internet caiu' })).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'O roteador desligou' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Deixe preparado' })).toBeVisible();
    await expect(page.getByText('mesmo nome e a mesma senha do Wi-Fi de casa')).toBeVisible();
    await expect(page.getByText('Ligue o celular ao PC por cabo USB.')).toBeVisible();
    await expect(page.getByText('iPhone:')).toBeVisible();
    await expect(page.getByText('Android:')).toBeVisible();
    await settle(page);

    // Só texto: nenhum botão que mande algo à TV, e a tela não fez comando nenhum.
    await expect(page.locator('app-tv-offline-guide-page button')).toHaveCount(0);
    expect(tv.settingsScreens()).toEqual([]);
    expect(tv.keysSent()).toEqual([]);

    await screenshot(page, join(SHOTS, `se-a-internet-cair-${info.project.name}.png`));
    await expectSound(page);

    await page.getByRole('link', { name: 'Voltar ao Controle' }).last().click();
    await expect(page).toHaveURL(/\/tv\/$/);
  });
});
