import { Page, TestInfo } from '@playwright/test';
import { GUEST, IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { expectNoA11yViolations, settle, smallTargets } from './screen-helpers';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

let mock: IdentityMock;

test.beforeEach(async ({ context, page }) => {
  // O WebKit do Playwright não traz WebAuthn; sem ele a Segurança esconde o botão de cadastrar passkey.
  await page.addInitScript(() => {
    if (!('PublicKeyCredential' in window)) {
      Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true });
    }
    if (!navigator.credentials) {
      Object.defineProperty(navigator, 'credentials', {
        value: { get: async () => null, create: async () => null },
        configurable: true,
      });
    }
  });
  mock = await mockIdentityApi(context);
  mock.loggedIn = true;
  await mockTvApi(context, mock);
  await installFakeEventSource(page);
});

/**
 * Passkeys, dois convites pendentes (a TV de sempre e uma lista misturada) e três convidados (a TV de sempre, só o
 * Treino e um com acesso revogado): as listas aparecem cheias e com resumos diferentes.
 */
function seedAccount(): void {
  mock.passkeys.push(
    {
      id: 'p1',
      name: 'Notebook',
      rawId: 'a',
      createdAt: '2026-09-02T12:00:00Z',
      lastUsedAt: '2026-10-18T09:00:00Z',
    },
    { id: 'p2', name: 'Celular', rawId: 'b', createdAt: '2026-10-01T12:00:00Z', lastUsedAt: null },
  );
  mock.seedInvite('Alice');
  mock.seedInvite('Dani', ['module:tv', 'tv:edit-shortcuts', 'module:training']);
  mock.guests.push(
    {
      id: 'g1',
      displayName: 'Bruno',
      email: 'bruno@exemplo.com',
      password: 'x',
      createdAt: '2026-10-10T10:00:00Z',
      disabledAt: null,
    },
    {
      id: 'g3',
      displayName: 'Raphael',
      email: 'raphael@exemplo.com',
      password: 'x',
      createdAt: '2026-10-12T10:00:00Z',
      disabledAt: null,
      permissions: ['module:training'],
    },
    {
      id: 'g2',
      displayName: 'Carla',
      email: 'carla@exemplo.com',
      password: 'x',
      createdAt: '2026-10-05T10:00:00Z',
      disabledAt: '2026-10-12T10:00:00Z',
    },
  );
}

/** A convidada com a sessão aberta (o papel decide o que `/me` devolve e o que a API recusa). */
function signInAsGuest(): void {
  mock.guests.push({
    id: '00000000-0000-4000-8000-000000000051',
    displayName: GUEST.displayName,
    email: GUEST.email,
    password: GUEST.password,
    createdAt: '2026-10-19T15:00:00Z',
    disabledAt: null,
  });
  mock.role = 'guest';
}

const shot = (info: TestInfo, name: string, scheme: Scheme) =>
  `test-results/settings-profile/${name}-${info.project.name}-${scheme}.png`;

function landscape(info: TestInfo) {
  const { width, height } = info.project.use.viewport!;
  return { width: height, height: width };
}

async function open(page: Page, path: string, title: string, scheme: Scheme) {
  // Movimento reduzido: as animações de entrada saem do caminho e o axe mede as cores finais (o executor da CI é lento).
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await settle(page);
}

/**
 * O mesmo roteiro para toda tela nova: sem rolagem de lado, print, alvos de 44 px e o axe sem nenhuma violação.
 * Folha e diálogo saem no print da janela (como aparecem no aparelho), não da página inteira.
 */
async function check(
  page: Page,
  info: TestInfo,
  name: string,
  scheme: Scheme,
  options: { fullPage?: boolean; dir?: string } = {},
) {
  await expectNoHorizontalScroll(page);
  const file = options.dir
    ? `test-results/${options.dir}/${name}-${info.project.name}-${scheme}.png`
    : shot(info, name, scheme);
  await screenshot(page, file, { fullPage: options.fullPage ?? true });
  expect(await smallTargets(page)).toEqual([]);
  await expectNoA11yViolations(page);
}

const OWNER_SCREENS = [
  { name: 'list', path: '/ajustes', title: 'Ajustes' },
  { name: 'profile', path: '/ajustes/perfil', title: 'Perfil' },
  { name: 'appearance', path: '/ajustes/aparencia', title: 'Aparência' },
  { name: 'security', path: '/ajustes/seguranca', title: 'Segurança' },
  { name: 'people', path: '/ajustes/pessoas', title: 'Pessoas' },
  { name: 'about', path: '/ajustes/sobre', title: 'Sobre' },
] as const;

const GUEST_SCREENS = [
  { name: 'guest-list', path: '/ajustes', title: 'Ajustes' },
  { name: 'guest-profile', path: '/ajustes/perfil', title: 'Perfil' },
  { name: 'guest-appearance', path: '/ajustes/aparencia', title: 'Aparência' },
  { name: 'guest-about', path: '/ajustes/sobre', title: 'Sobre' },
] as const;

test.describe('Ajustes do administrador: cada tela', () => {
  for (const scheme of SCHEMES) {
    for (const screen of OWNER_SCREENS) {
      test(`${screen.title}: print, alvos e acessibilidade no tema ${scheme}`, async ({
        page,
      }, info) => {
        seedAccount();
        await open(page, screen.path, screen.title, scheme);
        if (screen.name === 'security') {
          await expect(page.getByText('Notebook', { exact: true })).toBeVisible();
        }
        if (screen.name === 'people') {
          await expect(page.getByText('Bruno', { exact: true })).toBeVisible();
        }
        await check(page, info, screen.name, scheme);
      });
    }

    test(`em paisagem curta a lista e o Perfil cabem, no tema ${scheme}`, async ({
      page,
    }, info) => {
      seedAccount();
      await page.setViewportSize(landscape(info));
      for (const screen of OWNER_SCREENS.filter((s) => ['list', 'profile'].includes(s.name))) {
        await open(page, screen.path, screen.title, scheme);
        await expectNoHorizontalScroll(page);
        expect(await smallTargets(page)).toEqual([]);
        await screenshot(page, shot(info, `${screen.name}-landscape`, scheme), { fullPage: true });
      }
    });
  }
});

test.describe('Ajustes da convidada: cada tela', () => {
  for (const scheme of SCHEMES) {
    for (const screen of GUEST_SCREENS) {
      test(`${screen.name}: print, alvos e acessibilidade no tema ${scheme}`, async ({
        page,
      }, info) => {
        signInAsGuest();
        await open(page, screen.path, screen.title, scheme);
        await check(page, info, screen.name, scheme);
      });
    }

    test(`em paisagem curta a lista e o Perfil da convidada cabem, no tema ${scheme}`, async ({
      page,
    }, info) => {
      signInAsGuest();
      await page.setViewportSize(landscape(info));
      for (const screen of GUEST_SCREENS.filter((s) =>
        ['guest-list', 'guest-profile'].includes(s.name),
      )) {
        await open(page, screen.path, screen.title, scheme);
        await expectNoHorizontalScroll(page);
        expect(await smallTargets(page)).toEqual([]);
        await screenshot(page, shot(info, `${screen.name}-landscape`, scheme), { fullPage: true });
      }
    });
  }
});

test.describe('navegação dentro de Ajustes', () => {
  test('cada linha leva à sua tela, o foco vai para o título e a seta volta para a lista', async ({
    page,
  }) => {
    await page.goto('/ajustes');
    await expect(page.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeVisible();
    for (const [row, title] of [
      [/^Perfil/, 'Perfil'],
      [/^Aparência/, 'Aparência'],
      [/^Segurança/, 'Segurança'],
      [/^Pessoas/, 'Pessoas'],
      [/^Sobre/, 'Sobre'],
    ] as const) {
      await page.getByRole('link', { name: row }).click();
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      // O foco está no título da tela nova (o link clicado já não existe).
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeFocused();
      await page.getByRole('link', { name: 'Voltar aos Ajustes' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeFocused();
    }
  });

  test('com movimento reduzido nada anima na lista nem nas telas', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const path of ['/ajustes', '/ajustes/perfil', '/ajustes/aparencia', '/ajustes/sobre']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const animations = await page.evaluate(() =>
        Array.from(document.querySelectorAll('main section, main .ui-card')).map(
          (el) => getComputedStyle(el).animationName,
        ),
      );
      expect(animations.length).toBeGreaterThan(0);
      expect(animations.every((name) => name === 'none')).toBe(true);
    }
  });

  test('o administrador continua com a seta na lista e na Início, nunca com o botão de configurações', async ({
    page,
  }) => {
    await page.goto('/ajustes');
    await expect(page.getByRole('link', { name: 'Voltar ao Início' })).toBeVisible();
    await expect(page.locator('header a[href="/ajustes"]')).toHaveCount(0);
  });

  test('um endereço de Ajustes que não existe leva à Início', async ({ page }) => {
    await page.goto('/ajustes/nada');
    await expect(page).toHaveURL(/\/$/);
  });
});

/** Cada estado da tela Pessoas, nos dois temas: convite novo, link, folha de permissões, erro e passkey. */
test.describe('Pessoas: cada estado', () => {
  const people = (page: Page, scheme: Scheme) => open(page, '/ajustes/pessoas', 'Pessoas', scheme);
  const sheet = (page: Page, name: string) =>
    page.getByRole('dialog', { name: `Permissões de ${name}` });
  const here = { dir: 'people-ui' };
  const overlay = { fullPage: false, dir: 'people-ui' };

  for (const scheme of SCHEMES) {
    test(`convite novo: recolhido, aberto e sem nenhum módulo, no tema ${scheme}`, async ({
      page,
    }, info) => {
      seedAccount();
      mock.stepUpValid = true;
      await people(page, scheme);
      await expect(page.getByText('Bruno', { exact: true })).toBeVisible();
      await check(page, info, 'people-list', scheme, here);

      await page.getByRole('button', { name: 'Convidar alguém' }).click();
      await page.getByLabel('Nome do convidado').fill('Raphael');
      await settle(page);
      await check(page, info, 'people-invite-folded', scheme, here);

      await page.getByRole('button', { name: /O que essa pessoa poderá fazer/ }).click();
      await settle(page);
      await check(page, info, 'people-invite-open', scheme, here);

      await page.getByRole('switch', { name: 'Ver a TV' }).uncheck();
      await expect(page.getByRole('button', { name: 'Gerar convite' })).toBeDisabled();
      await check(page, info, 'people-invite-none', scheme, here);
    });

    test(`link do convite, no tema ${scheme}`, async ({ page }, info) => {
      seedAccount();
      mock.stepUpValid = true;
      await people(page, scheme);
      await page.getByRole('button', { name: 'Convidar alguém' }).click();
      await page.getByLabel('Nome do convidado').fill('Raphael');
      await page.getByRole('button', { name: /O que essa pessoa poderá fazer/ }).click();
      await page.locator('label.model', { hasText: 'Só o Treino' }).click();
      await page.getByRole('button', { name: 'Gerar convite' }).click();
      await expect(page.getByLabel('Link do convite')).toBeVisible();
      await page.getByRole('button', { name: 'Copiar link' }).click();
      await settle(page);
      await check(page, info, 'people-link', scheme, here);
    });

    test(`folha de permissões: aberta, com a passkey e com erro, no tema ${scheme}`, async ({
      page,
    }, info) => {
      seedAccount();
      await people(page, scheme);
      await page.getByRole('button', { name: 'Permissões de Bruno' }).click();
      await expect(sheet(page, 'Bruno')).toBeVisible();
      await settle(page);
      await check(page, info, 'people-sheet', scheme, overlay);

      await sheet(page, 'Bruno')
        .getByRole('switch', { name: 'Editar e reordenar atalhos' })
        .check();
      await sheet(page, 'Bruno').getByRole('button', { name: 'Salvar' }).click();
      const confirm = page.getByRole('dialog', { name: 'Confirmar a mudança de permissões' });
      await expect(confirm).toBeVisible();
      await settle(page);
      await check(page, info, 'people-step-up', scheme, overlay);

      // Cancelar a confirmação deixa a folha com o aviso e o que a pessoa tinha marcado.
      await confirm.getByRole('button', { name: 'Cancelar' }).click();
      await expect(sheet(page, 'Bruno').getByRole('alert')).toBeVisible();
      await settle(page);
      await check(page, info, 'people-sheet-error', scheme, overlay);
    });

    test(`folha de uma pessoa só do Treino, e sem nenhum módulo, no tema ${scheme}`, async ({
      page,
    }, info) => {
      seedAccount();
      await people(page, scheme);
      await page.getByRole('button', { name: 'Permissões de Raphael' }).click();
      await expect(sheet(page, 'Raphael')).toBeVisible();
      await settle(page);
      await check(page, info, 'people-sheet-training', scheme, overlay);

      await sheet(page, 'Raphael').getByRole('switch', { name: 'Usar o Treino' }).uncheck();
      await expect(sheet(page, 'Raphael').getByRole('button', { name: 'Salvar' })).toBeDisabled();
      await check(page, info, 'people-sheet-none', scheme, overlay);
    });
  }
});
