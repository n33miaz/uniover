import { join } from 'node:path';
import { Page, TestInfo } from '@playwright/test';
import { IdentityMock, MockGuest, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { MockComputer, SystemMock, mockSystemApi } from '../system/system-mock';
import { MockTv, TvMock, installFakeEventSource, mockTvApi } from '../tv/tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints (o orquestrador aponta uma pasta); sem a variável, ficam em `test-results`. */
const SHOTS = process.env['TV_MULTI_SHOTS'] ?? 'test-results';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

let identity: IdentityMock;
let tv: TvMock;
let system: SystemMock;

const PC_CASA: MockComputer = {
  slug: 'pc-casa',
  name: 'PC de casa',
  platform: 'windows',
  online: true,
  revoked: false,
};
const PC_RAPHAEL: MockComputer = {
  slug: 'pc-raphael',
  name: 'PC do Raphael',
  platform: 'windows',
  online: false,
  revoked: false,
};
const NOTEBOOK: MockComputer = {
  slug: 'notebook',
  name: 'Notebook',
  platform: 'linux',
  online: true,
  revoked: false,
};

const CASA: MockTv = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Casa',
  isDefault: true,
  agentSlug: 'pc-casa',
  kind: 'android',
  online: true,
  capabilities: ['tv.remote', 'tv.kind.android', 'tv.adb'],
};
const RAPHAEL: MockTv = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Raphael',
  isDefault: false,
  agentSlug: 'pc-raphael',
  kind: 'samsung',
  online: false,
  capabilities: [],
};

const BRUNO: MockGuest = {
  id: '00000000-0000-4000-8000-0000000000b1',
  displayName: 'Bruno',
  email: 'bruno@exemplo.com',
  password: 'x',
  createdAt: '2026-10-10T10:00:00Z',
  disabledAt: null,
};
const BIA: MockGuest = {
  id: '00000000-0000-4000-8000-0000000000b2',
  displayName: 'Bia',
  email: 'bia@exemplo.com',
  password: 'x',
  createdAt: '2026-10-12T10:00:00Z',
  disabledAt: null,
};
const ANTIGA: MockGuest = {
  id: '00000000-0000-4000-8000-0000000000b3',
  displayName: 'Antiga',
  email: 'antiga@exemplo.com',
  password: 'x',
  createdAt: '2026-10-01T10:00:00Z',
  disabledAt: '2026-10-05T10:00:00Z',
};

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  // A confirmação com a passkey vale (o WebKit do Playwright não tem autenticador virtual); a recusa dela é dos testes unitários.
  identity.stepUpValid = true;
  identity.guests.push({ ...BRUNO }, { ...BIA }, { ...ANTIGA });
  tv = await mockTvApi(context, identity);
  // Depois do mock da TV: a rota registrada por último vence, e a configuração mora sob o mesmo prefixo.
  system = await mockSystemApi(context, identity);
  await installFakeEventSource(page);
});

/** Duas TVs (a de casa e a do Raphael), os dois computadores delas pareados e um notebook ainda sem TV. */
function seed(withFree = true): void {
  tv.tvs = [{ ...CASA }, { ...RAPHAEL }];
  tv.members[RAPHAEL.id] = [BIA.id];
  system.computers.push({ ...PC_CASA }, { ...PC_RAPHAEL });
  if (withFree) system.computers.push({ ...NOTEBOOK });
  system.current = PC_CASA.slug;
  system.source = 'saved';
}

async function open(page: Page, scheme: Scheme = 'light') {
  // Movimento reduzido: as animações de entrada saem do caminho e o axe mede as cores finais (o executor da CI é lento).
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.goto('/ajustes/sistema');
  await expect(page.getByRole('heading', { level: 1, name: 'Sistema' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'TVs', exact: true })).toBeVisible();
  await expect(page.locator('ul.tvs')).toBeVisible();
}

const shot = (info: TestInfo, name: string, scheme: Scheme) =>
  join(SHOTS, `${name}-${info.project.name}-${scheme}.png`);

/** O roteiro de toda tela: sem rolagem de lado, print, alvos de 44 px e o axe sem nenhuma violação. */
async function check(page: Page, info: TestInfo, name: string, scheme: Scheme) {
  await settle(page);
  await expectNoHorizontalScroll(page);
  await screenshot(page, shot(info, name, scheme));
  expect(await smallTargets(page)).toEqual([]);
  await expectNoA11yViolations(page);
}

const row = (page: Page, name: string) =>
  page.locator('ul.tvs button.ui-row', { has: page.getByText(name, { exact: true }) });
const sheet = (page: Page) => page.locator('app-tv-edit-sheet dialog');
const writes = (method: string) => tv.requests.filter((r) => r.method === method);

test.describe('Configurações > Sistema > TVs', () => {
  test('a linha Sistema leva à tela das TVs', async ({ page }) => {
    seed();
    await page.goto('/ajustes');
    await page.getByRole('link', { name: /Sistema/ }).click();
    await expect(page).toHaveURL(/\/ajustes\/sistema$/);
    await expect(page.getByRole('heading', { level: 2, name: 'TVs', exact: true })).toBeVisible();
  });

  for (const scheme of SCHEMES) {
    test(`lista as TVs com o computador, o tipo e o estado, no tema ${scheme}`, async ({
      page,
    }, info) => {
      seed();
      await open(page, scheme);
      await expect(row(page, 'Casa')).toContainText('PC de casa · Android');
      await expect(row(page, 'Casa')).toContainText('Ligado');
      await expect(row(page, 'Raphael')).toContainText('PC do Raphael · Samsung');
      await expect(row(page, 'Raphael')).toContainText('Desligado');
      await expect(page.getByRole('button', { name: 'Adicionar TV' })).toBeVisible();
      await check(page, info, 'tvs-lista', scheme);
    });

    test(`abre a TV com o nome, o computador e quem usa, no tema ${scheme}`, async ({
      page,
    }, info) => {
      seed();
      await open(page, scheme);
      await row(page, 'Raphael').click();
      const dialog = sheet(page);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', { name: 'Editar TV' })).toBeVisible();
      await expect(dialog.getByLabel('Nome')).toHaveValue('Raphael');
      await expect(dialog.getByRole('radio', { name: /PC do Raphael/ })).toBeChecked();
      // Só as contas ativas; quem já usa a TV vem marcado.
      await expect(dialog.getByRole('switch', { name: 'Bia' })).toBeChecked();
      await expect(dialog.getByRole('switch', { name: 'Bruno' })).not.toBeChecked();
      await expect(dialog.getByRole('switch', { name: 'Antiga' })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Salvar' })).toBeDisabled();
      await check(page, info, 'tvs-quem-usa', scheme);
    });

    test(`mostra o formulário de uma TV nova, no tema ${scheme}`, async ({ page }, info) => {
      seed();
      await open(page, scheme);
      await page.getByRole('button', { name: 'Adicionar TV' }).click();
      const dialog = sheet(page);
      await expect(dialog.getByRole('heading', { name: 'Nova TV' })).toBeVisible();
      // O único computador livre já vem escolhido; falta só o nome.
      await expect(dialog.getByRole('radio', { name: /Notebook/ })).toBeChecked();
      await expect(dialog.getByRole('button', { name: 'Salvar' })).toBeDisabled();
      await check(page, info, 'tvs-nova', scheme);
    });
  }

  test('adiciona uma TV com o computador livre e as pessoas marcadas', async ({ page }) => {
    seed();
    await open(page);
    await page.getByRole('button', { name: 'Adicionar TV' }).click();
    const dialog = sheet(page);
    await dialog.getByLabel('Nome').fill('Quarto');
    await dialog.getByRole('switch', { name: 'Bruno' }).check();
    await dialog.getByRole('button', { name: 'Salvar' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText('Pronto: as TVs foram atualizadas.')).toBeVisible();
    await expect(row(page, 'Quarto')).toContainText('Notebook');
    expect(writes('POST').map((r) => r.body)).toEqual([{ agentSlug: 'notebook', name: 'Quarto' }]);
    const created = tv.tvs!.find((item) => item.name === 'Quarto')!;
    expect(tv.members[created.id]).toEqual([BRUNO.id]);

    // Todo computador já tem uma TV: a ação some e a tela leva a Aparelhos.
    await expect(page.getByRole('button', { name: 'Adicionar TV' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Ir para Dispositivos' })).toHaveAttribute(
      'href',
      '/ajustes/dispositivos',
    );
  });

  test('sem computador livre explica e leva a Aparelhos', async ({ page }, info) => {
    seed(false);
    await open(page);
    await expect(page.getByRole('button', { name: 'Adicionar TV' })).toHaveCount(0);
    await expect(page.getByText('Todo computador pareado já tem uma TV')).toBeVisible();
    await check(page, info, 'tvs-sem-livre', 'light');
  });

  test('renomeia, troca o computador e muda quem usa, mandando só o que mudou', async ({
    page,
  }) => {
    seed();
    await open(page);
    await row(page, 'Raphael').click();
    const dialog = sheet(page);
    await dialog.getByLabel('Nome').fill('Casa do Raphael');
    await dialog.getByRole('radio', { name: /Notebook/ }).check();
    await dialog.getByRole('switch', { name: 'Bia' }).uncheck();
    await dialog.getByRole('switch', { name: 'Bruno' }).check();
    await dialog.getByRole('button', { name: 'Salvar' }).click();
    await expect(dialog).toBeHidden();

    await expect(row(page, 'Casa do Raphael')).toContainText('Notebook');
    expect(writes('PATCH').map((r) => r.body)).toEqual([
      { name: 'Casa do Raphael', agentSlug: 'notebook' },
    ]);
    expect(writes('PUT').map((r) => r.body)).toEqual([{ userIds: [BRUNO.id] }]);
    expect(tv.members[RAPHAEL.id]).toEqual([BRUNO.id]);
  });

  test('só as pessoas mudaram: a TV não é tocada', async ({ page }) => {
    seed();
    await open(page);
    await row(page, 'Raphael').click();
    await sheet(page).getByRole('switch', { name: 'Bruno' }).check();
    await sheet(page).getByRole('button', { name: 'Salvar' }).click();
    await expect(sheet(page)).toBeHidden();
    expect(writes('PATCH')).toEqual([]);
    expect(tv.members[RAPHAEL.id].sort()).toEqual([BIA.id, BRUNO.id].sort());
  });

  test('remove a TV depois de perguntar, e a padrão não tem esse botão', async ({ page }) => {
    seed();
    await open(page);

    await row(page, 'Casa').click();
    await expect(sheet(page).getByRole('heading', { name: 'Editar TV' })).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: 'Remover TV' })).toHaveCount(0);
    await sheet(page).getByRole('button', { name: 'Cancelar' }).click();
    await expect(sheet(page)).toBeHidden();
    expect(writes('DELETE')).toEqual([]);

    await row(page, 'Raphael').click();
    await sheet(page).getByRole('button', { name: 'Remover TV' }).click();
    await expect(sheet(page).getByText('Remover esta TV?')).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Manter' }).click();
    await expect(sheet(page).getByText('Remover esta TV?')).toHaveCount(0);
    expect(writes('DELETE')).toEqual([]);

    await sheet(page).getByRole('button', { name: 'Remover TV' }).click();
    await sheet(page).getByRole('button', { name: 'Remover', exact: true }).click();
    await expect(sheet(page)).toBeHidden();
    await expect(row(page, 'Raphael')).toHaveCount(0);
    expect(writes('DELETE')).toHaveLength(1);
    expect(tv.tvs!.map((item) => item.name)).toEqual(['Casa']);
    // O computador dele voltou a estar livre.
    await expect(page.getByRole('button', { name: 'Adicionar TV' })).toBeVisible();
  });

  test('uma conta que não é a do administrador nunca chega a esta tela nem lê a configuração', async ({
    page,
  }) => {
    seed();
    identity.guests.length = 0;
    identity.guests.push({ ...BRUNO, permissions: ['module:tv'] });
    identity.role = 'guest';
    await page.goto('/ajustes/sistema');
    await page.waitForLoadState('networkidle');
    await expect(page).not.toHaveURL(/\/ajustes\/sistema$/);
    expect(system.requests).toEqual([]);
    expect(writes('POST').concat(writes('PATCH'), writes('PUT'), writes('DELETE'))).toEqual([]);
  });
});
