import { Page, TestInfo } from '@playwright/test';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { IdentityMock, OWNER, OWNER_ID, mockIdentityApi } from '../auth/identity-mock';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { expectNoA11yViolations, settle, smallTargets } from './screen-helpers';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde ficam os prints desta entrega (só no projeto do iPhone 12, tema claro); `HOME_SYNC_PRINTS` troca a pasta. */
const PRINTS = process.env['HOME_SYNC_PRINTS'] ?? 'test-results/home-sync';

async function printIfIphone(page: Page, info: TestInfo, name: string) {
  if (info.project.name !== 'iphone-12') return;
  await screenshot(page, `${PRINTS}/home-sync-${name}.png`);
}

let mock: IdentityMock;

test.beforeEach(async ({ context, page }) => {
  mock = await mockIdentityApi(context);
  mock.loggedIn = true;
  await mockTvApi(context, mock);
  await installFakeEventSource(page);
});

const HOME_CARDS = 8;

async function openHome(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    OWNER.displayName.split(' ')[0],
  );
  await expect(page.locator('article.card').first()).toBeVisible();
  await settle(page);
}

const visibleModules = (page: Page) =>
  page
    .locator('article.card')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-module')));

test.describe('Início sincronizada com a conta', () => {
  test('Personalizar grava na conta e um aparelho sem nada local recebe a mesma Início', async ({
    page,
  }) => {
    await openHome(page);
    await expect(page.locator('article.card')).toHaveCount(HOME_CARDS);
    // Ao abrir sem nada na conta nem no aparelho, nada é enviado.
    expect(mock.preferenceWrites).toBe(0);

    await page.getByRole('button', { name: 'Editar' }).click();
    const sheet = page.getByRole('dialog', { name: 'Personalizar' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('switch', { name: 'Mostrar TV na Início' }).setChecked(false);
    await sheet.getByRole('button', { name: 'Concluir' }).click();
    await expect(page.locator('article.card[data-module="tv"]')).toHaveCount(0);

    await expect.poll(() => mock.preferenceWrites).toBe(1);
    const saved = mock.preferences[OWNER_ID];
    expect(saved.version).toBe(1);
    expect(saved.home?.find((entry) => entry.id === 'tv')).toEqual({ id: 'tv', enabled: false });

    // Outro aparelho: nada guardado nele, a Início vem da conta.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator('article.card').first()).toBeVisible();
    await expect(page.locator('article.card[data-module="tv"]')).toHaveCount(0);
    await expect(page.locator('article.card[data-module="training"]')).toBeVisible();
    expect(mock.preferenceWrites).toBe(1);
  });

  test('a escolha que já está na conta vale sobre o aparelho, na ordem e na visibilidade', async ({
    page,
  }) => {
    mock.preferences[OWNER_ID] = {
      version: 4,
      home: [
        { id: 'training', enabled: true },
        { id: 'tv', enabled: false },
      ],
    };
    await openHome(page);

    await expect.poll(async () => (await visibleModules(page))[0]).toBe('training');
    await expect(page.locator('article.card[data-module="tv"]')).toHaveCount(0);
    expect(mock.preferenceWrites).toBe(0);
  });

  test('o que o aparelho já tinha sobe uma vez para a conta e não sobe de novo', async ({
    page,
  }) => {
    await page.addInitScript((account) => {
      // Só na primeira carga: o init script roda em toda navegação.
      if (localStorage.getItem('e2e-seeded')) return;
      localStorage.setItem('e2e-seeded', '1');
      localStorage.setItem(
        `uniover.home.widgets.v1.${account}`,
        JSON.stringify([
          { id: 'training', size: 'small', enabled: true },
          { id: 'tv', size: 'small', enabled: false },
        ]),
      );
    }, OWNER_ID);
    await openHome(page);

    await expect.poll(() => mock.preferenceWrites).toBe(1);
    expect(mock.preferences[OWNER_ID].home?.slice(0, 2)).toEqual([
      { id: 'training', enabled: true },
      { id: 'tv', enabled: false },
    ]);

    await page.reload();
    await expect(page.locator('article.card').first()).toBeVisible();
    await settle(page);
    expect(mock.preferenceWrites).toBe(1);
    await expect(page.locator('article.card[data-module="tv"]')).toHaveCount(0);
  });

  test('sem rede a escolha vale no aparelho e sobe quando a conexão volta', async ({ page }) => {
    await openHome(page);
    mock.offline = true;
    await page.getByRole('button', { name: 'Editar' }).click();
    const sheet = page.getByRole('dialog', { name: 'Personalizar' });
    await sheet.getByRole('switch', { name: 'Mostrar Treino na Início' }).setChecked(false);
    await sheet.getByRole('button', { name: 'Concluir' }).click();
    await expect(page.locator('article.card[data-module="training"]')).toHaveCount(0);
    expect(mock.preferences[OWNER_ID]).toBeUndefined();

    mock.offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => mock.preferences[OWNER_ID]?.version).toBe(1);
    expect(mock.preferences[OWNER_ID].home?.find((entry) => entry.id === 'training')).toEqual({
      id: 'training',
      enabled: false,
    });
  });

  test('a escolha de um aparelho não apaga a mais nova de outro (a conta vence)', async ({
    page,
  }) => {
    await openHome(page);
    // Outro aparelho grava antes, sem este saber.
    mock.preferences[OWNER_ID] = {
      version: 3,
      home: [
        { id: 'training', enabled: true },
        { id: 'tv', enabled: true },
      ],
    };
    await page.getByRole('button', { name: 'Editar' }).click();
    const sheet = page.getByRole('dialog', { name: 'Personalizar' });
    await sheet.getByRole('switch', { name: 'Mostrar TV na Início' }).setChecked(false);
    await sheet.getByRole('button', { name: 'Concluir' }).click();

    await expect.poll(() => mock.preferenceWrites).toBe(1);
    expect(mock.preferences[OWNER_ID].version).toBe(3);
    await expect.poll(async () => (await visibleModules(page))[0]).toBe('training');
    await expect(page.locator('article.card[data-module="tv"]')).toBeVisible();
  });
});

test.describe('Pessoas e Sessões mostram o que cada um deixou', () => {
  function seedPeople(): void {
    mock.guests.push(
      {
        id: '00000000-0000-4000-8000-000000000051',
        displayName: 'Raphael',
        email: 'raphael@exemplo.com',
        password: 'x',
        createdAt: '2026-10-10T10:00:00Z',
        disabledAt: null,
        permissions: ['module:tv', 'tv:control', 'tv:power', 'tv:launch', 'module:training'],
      },
      {
        id: '00000000-0000-4000-8000-000000000052',
        displayName: 'Bia',
        email: 'bia@exemplo.com',
        password: 'x',
        createdAt: '2026-10-11T10:00:00Z',
        disabledAt: null,
        permissions: ['module:tv', 'tv:control'],
      },
      {
        id: '00000000-0000-4000-8000-000000000053',
        displayName: 'Caio',
        email: 'caio@exemplo.com',
        password: 'x',
        createdAt: '2026-10-12T10:00:00Z',
        disabledAt: null,
      },
    );
    mock.peopleHome['00000000-0000-4000-8000-000000000051'] = {
      state: 'custom',
      entries: [
        { id: 'tv', enabled: true },
        { id: 'training', enabled: true },
        { id: 'health', enabled: false },
      ],
    };
    mock.peopleHome['00000000-0000-4000-8000-000000000052'] = { state: 'default', entries: [] };
    mock.guestSessions['00000000-0000-4000-8000-000000000051'] = [
      {
        id: '00000000-0000-4000-8000-0000000000a1',
        userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148',
        ip: '203.0.113.0/24',
        createdAt: '2026-10-25T10:00:00Z',
        lastUsedAt: '2026-10-31T10:00:00Z',
        isCurrent: false,
        platform: 'iphone',
        installed: true,
      },
      {
        id: '00000000-0000-4000-8000-0000000000a2',
        userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/17.5 Safari/604.1',
        ip: '203.0.113.0/24',
        createdAt: '2026-10-20T10:00:00Z',
        lastUsedAt: '2026-10-22T10:00:00Z',
        isCurrent: false,
        platform: 'iphone',
        installed: false,
      },
    ];
  }

  test('a linha Início de cada pessoa e as sessões com o app instalado', async ({ page }, info) => {
    seedPeople();
    await page.goto('/ajustes/pessoas');
    await expect(page.getByRole('heading', { level: 1, name: 'Pessoas' })).toBeVisible();
    const homeLine = (name: string) =>
      page.locator('li.person').filter({ hasText: name }).locator('.home-line');

    await expect(homeLine('Raphael')).toHaveText('TV, Treino');
    await expect(homeLine('Bia')).toHaveText('Padrão');
    await expect(homeLine('Caio')).toHaveText('Sem dados ainda');
    // O dono também aparece, como "Você".
    await expect(page.locator('.owner-usage .home-line')).toHaveText('Padrão');
    await expectNoHorizontalScroll(page);
    await settle(page);
    await printIfIphone(page, info, 'pessoas-inicio');
    expect(await smallTargets(page)).toEqual([]);
    await expectNoA11yViolations(page);

    await page
      .locator('li.person')
      .filter({ hasText: 'Raphael' })
      .getByRole('button', { name: 'Sessões' })
      .click();
    await expect(page.getByText('iPhone · App Instalado')).toBeVisible();
    await expect(page.getByText('iPhone · Safari')).toBeVisible();
    await settle(page);
    await page.getByText('iPhone · App Instalado').scrollIntoViewIfNeeded();
    await printIfIphone(page, info, 'sessoes-app-instalado');
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
  });

  test('a Início do dono em Pessoas acompanha o que ele salvou', async ({ page }) => {
    mock.preferences[OWNER_ID] = {
      version: 2,
      home: [
        { id: 'training', enabled: true },
        { id: 'tv', enabled: true },
      ],
    };
    await page.goto('/ajustes/pessoas');
    await expect(page.locator('.owner-usage .home-line')).toHaveText('Treino, TV');
  });

  test('o convidado não vê a Início nem as sessões de ninguém, e não consulta as rotas do dono', async ({
    page,
    context,
  }) => {
    seedPeople();
    mock.role = 'guest';
    mock.guestPermissions = ['module:tv', 'tv:control'];
    const urls: string[] = [];
    page.on('request', (request) => urls.push(new URL(request.url()).pathname));
    await context.addInitScript(() => undefined);
    await page.goto('/ajustes/pessoas');
    // O convidado não tem a tela de Pessoas: nenhuma linha de outra pessoa aparece.
    await expect(page.locator('.home-line')).toHaveCount(0);
    expect(urls.filter((path) => /people-usage|\/guests/.test(path))).toEqual([]);
  });
});
