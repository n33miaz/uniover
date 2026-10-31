import { join } from 'node:path';
import { Page } from '@playwright/test';
import { GUEST, IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { MockComputer, SystemMock, mockSystemApi } from '../system/system-mock';
import { MockTv, TvMock, installFakeEventSource, mockTvApi } from './tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints (o orquestrador aponta uma pasta); sem a variável, ficam em `test-results`. */
const SHOTS = process.env['TV_PERMISSION_SHOTS'] ?? 'test-results';

const RAPHAEL_ACCOUNT = '00000000-0000-4000-8000-000000000061';
const CASA: MockTv = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Casa',
  isDefault: true,
  agentSlug: 'pc-casa',
  kind: 'android',
  online: true,
  capabilities: ['tv.remote', 'tv.kind.android'],
};
const RAPHAEL: MockTv = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Raphael',
  isDefault: false,
  agentSlug: 'pc-raphael',
  kind: 'samsung',
  online: true,
  capabilities: ['tv.remote', 'tv.kind.samsung', 'tv.permission.v1'],
  permissionNeeded: true,
};

let identity: IdentityMock;
let tv: TvMock;
let system: SystemMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  identity.stepUpValid = true;
  tv = await mockTvApi(context, identity);
  system = await mockSystemApi(context, identity);
  await installFakeEventSource(page);
});

/** A conta do Raphael: convidada, com o controle da TV, membro só da TV dele. */
function signInAsRaphael(): void {
  identity.guests.push({
    id: RAPHAEL_ACCOUNT,
    displayName: 'Raphael',
    email: GUEST.email,
    password: GUEST.password,
    createdAt: '2026-10-19T15:00:00Z',
    disabledAt: null,
    permissions: ['module:tv', 'tv:control'],
  });
  identity.role = 'guest';
  tv.tvs = [{ ...CASA }, { ...RAPHAEL }];
  tv.members[RAPHAEL.id] = [RAPHAEL_ACCOUNT];
}

// O nome do diálogo é o título da etapa (muda de "Permissão da TV" para "Pronto" etc.): por isso o seletor é a folha.
const sheet = (page: Page) => page.locator('app-tv-permission-sheet dialog');

async function reduced(page: Page): Promise<void> {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

test.describe('a folha de permissão ao entrar', () => {
  test('aparece antes de qualquer outra tela para quem usa aquela TV, e pede o aviso uma vez', async ({
    page,
  }, info) => {
    signInAsRaphael();
    await reduced(page);
    await page.goto('/');

    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByRole('heading', { level: 2 })).toHaveText('Permissão da TV');
    await expect(sheet(page)).toContainText(
      'Na próxima vez que a TV mostrar um pedido do UniOver, escolha Permitir. É uma vez só.',
    );
    // Modal: o resto do app fica inerte até a resposta.
    await expect(page.getByRole('link', { name: /TV/ }).first()).not.toBeFocused();
    await settle(page);
    await expectNoHorizontalScroll(page);
    expect(await smallTargets(page)).toEqual([]);
    await expectNoA11yViolations(page);
    if (info.project.name === 'iphone-12') {
      await screenshot(page, join(SHOTS, 'tv-permission-sheet-iphone-12-light.png'));
    }

    await sheet(page).getByRole('button', { name: 'Pedir Agora' }).click();
    await expect(sheet(page).getByRole('heading', { level: 2 })).toHaveText('Pronto', {
      timeout: 15_000,
    });
    expect(tv.count('/permission/request')).toBe(1);
    expect(
      tv.requests.find((r) => r.path === '/permission/request')?.tvId,
      'o pedido vai pela TV do Raphael',
    ).toBe(RAPHAEL.id);
    await sheet(page).getByRole('button', { name: 'Fechar' }).click();
    await expect(sheet(page)).toBeHidden();
  });

  test('Depois esconde nesta visita e a folha volta na próxima entrada', async ({
    page,
    context,
  }) => {
    signInAsRaphael();
    await reduced(page);
    await page.goto('/');
    await sheet(page).getByRole('button', { name: 'Depois' }).click();
    await expect(sheet(page)).toBeHidden();
    expect(tv.count('/permission/request')).toBe(0);

    // Recarregar na mesma aba não incomoda de novo...
    await page.reload();
    await expect(page.locator('main')).toBeVisible();
    await expect(sheet(page)).toBeHidden();

    // ...mas uma entrada nova (outra aba) sim, enquanto a TV precisar.
    const next = await context.newPage();
    await installFakeEventSource(next);
    await reduced(next);
    await next.goto('/');
    await expect(sheet(next)).toBeVisible();
  });

  test('a TV que reconhece o UniOver não mostra folha nenhuma', async ({ page }) => {
    signInAsRaphael();
    tv.tvs = [{ ...CASA }, { ...RAPHAEL, permissionNeeded: false }];
    await reduced(page);
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    await expect(sheet(page)).toBeHidden();
  });

  test('outra pessoa, de outra TV, nunca vê o aviso do Raphael', async ({ page }) => {
    signInAsRaphael();
    tv.members[RAPHAEL.id] = ['00000000-0000-4000-8000-0000000000ff'];
    await reduced(page);
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    await expect(sheet(page)).toBeHidden();
  });

  test('o administrador não é interrompido pela TV de outra pessoa', async ({ page }) => {
    identity.role = 'owner';
    tv.tvs = [{ ...CASA }, { ...RAPHAEL }];
    await reduced(page);
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    await expect(sheet(page)).toBeHidden();
  });

  test('com a TV desligada ou fora de alcance conta o que houve e deixa tentar de novo', async ({
    page,
  }) => {
    signInAsRaphael();
    tv.permissionAnswer = 'unreachable';
    await reduced(page);
    await page.goto('/');
    await sheet(page).getByRole('button', { name: 'Pedir Agora' }).click();
    await expect(sheet(page).getByRole('heading', { level: 2 })).toHaveText('A TV Não Respondeu');
    await expect(sheet(page)).toContainText('Ligue a TV e tente de novo.');
    tv.permissionAnswer = 'asked';
    await sheet(page).getByRole('button', { name: 'Tentar de Novo' }).click();
    await expect(sheet(page).getByRole('heading', { level: 2 })).toHaveText('Pronto', {
      timeout: 15_000,
    });
  });

  test('computador desatualizado explica que precisa atualizar', async ({ page }) => {
    signInAsRaphael();
    tv.permissionAnswer = 'unsupported';
    await reduced(page);
    await page.goto('/');
    await sheet(page).getByRole('button', { name: 'Pedir Agora' }).click();
    await expect(sheet(page)).toContainText('Atualize o computador da TV para pedir a permissão.');
  });

  test('falha ao ler a lista nunca prende ninguém', async ({ page }) => {
    signInAsRaphael();
    tv.tvs = null;
    await reduced(page);
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    await expect(sheet(page)).toBeHidden();
  });
});

const NOTEBOOK: MockComputer = {
  slug: 'notebook',
  name: 'Notebook da sala',
  platform: 'linux',
  online: true,
  revoked: false,
};
const PC_RAPHAEL: MockComputer = {
  slug: 'pc-raphael',
  name: 'PC do Raphael',
  platform: 'windows',
  online: true,
  revoked: false,
};
const PC_CASA: MockComputer = {
  slug: 'pc-casa',
  name: 'PC de casa',
  platform: 'windows',
  online: true,
  revoked: false,
};
const PC_QUARTO: MockComputer = {
  slug: 'pc-quarto',
  name: 'PC do quarto',
  platform: 'windows',
  online: false,
  revoked: false,
};

async function openSystem(page: Page): Promise<void> {
  await reduced(page);
  await page.goto('/ajustes/sistema');
  await expect(page.getByRole('heading', { level: 2, name: 'TVs', exact: true })).toBeVisible();
  await expect(page.locator('ul.tvs')).toBeVisible();
}

test.describe('Configurações da TV (administrador)', () => {
  test('a permissão pode ser pedida de novo pela TV Samsung', async ({ page }) => {
    identity.role = 'owner';
    tv.tvs = [{ ...CASA }, { ...RAPHAEL }];
    system.computers.push({ ...PC_CASA }, { ...PC_RAPHAEL });
    system.current = PC_CASA.slug;
    system.source = 'saved';
    await openSystem(page);

    await page
      .locator('ul.tvs')
      .getByRole('button', { name: /Raphael/ })
      .click();
    const edit = page.getByRole('dialog', { name: 'Editar TV' });
    await expect(edit).toContainText('A TV pediu a permissão do UniOver de novo.');
    await edit.getByRole('button', { name: 'Pedir Agora' }).click();
    await expect(sheet(page)).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Pedir Agora' }).click();
    await expect(sheet(page).getByRole('heading', { level: 2 })).toHaveText('Pronto', {
      timeout: 15_000,
    });
    await sheet(page).getByRole('button', { name: 'Fechar' }).click();
    await expect(edit).toContainText('A TV reconhece o UniOver.');
    expect(tv.count('/permission/request')).toBe(1);
  });

  test('a TV Android não oferece permissão', async ({ page }) => {
    identity.role = 'owner';
    tv.tvs = [{ ...CASA }, { ...RAPHAEL }];
    system.computers.push({ ...PC_CASA }, { ...PC_RAPHAEL });
    system.current = PC_CASA.slug;
    system.source = 'saved';
    await openSystem(page);
    await page.locator('ul.tvs').getByRole('button', { name: /Casa/ }).click();
    await expect(page.getByRole('dialog', { name: 'Editar TV' })).not.toContainText(
      'Permissão da TV',
    );
  });

  test('ao adicionar uma TV, as achadas na rede vêm primeiro, marcadas Na Sua Rede', async ({
    page,
  }, info) => {
    identity.role = 'owner';
    tv.tvs = [{ ...CASA }];
    system.computers.push({ ...PC_CASA }, { ...NOTEBOOK }, { ...PC_QUARTO });
    system.current = PC_CASA.slug;
    system.source = 'saved';
    tv.nearby['notebook'] = {
      status: 'ok',
      items: [{ id: 'a1b2c3d4e5f60718', kind: 'samsung', name: 'Samsung Sala', controlled: false }],
    };
    await openSystem(page);

    await page.getByRole('button', { name: /Adicionar/ }).click();
    const nova = page.getByRole('dialog', { name: 'Nova TV' });
    await expect(nova.getByText('TVs Encontradas', { exact: true }).first()).toBeVisible();
    const rows = nova.locator('label.choice');
    await expect(rows.first()).toContainText('Samsung Sala');
    await expect(rows.first()).toContainText('Na Sua Rede');
    // Os outros computadores livres vêm depois, sem repetir o que achou a TV.
    await expect(nova.getByText('Outros Computadores', { exact: true })).toBeVisible();
    await expect(rows.nth(1)).toContainText('PC do quarto');
    await expect(nova).not.toContainText('Procurando TVs…');
    await settle(page);
    await expectNoHorizontalScroll(page);
    expect(await smallTargets(page)).toEqual([]);
    await expectNoA11yViolations(page);
    if (info.project.name === 'iphone-12') {
      await screenshot(page, join(SHOTS, 'tv-nearby-list-iphone-12-light.png'));
    }

    // Escolher a TV achada escolhe o computador que a achou e usa o nome dela.
    await rows.first().click();
    await expect(nova.locator('#tv-edit-name')).toHaveValue('Samsung Sala');
    await nova.getByRole('button', { name: 'Salvar' }).click();
    await expect(nova).toBeHidden();
    const created = tv.requests.find((r) => r.method === 'POST' && r.path === '/tvs');
    expect(created?.body).toEqual({ agentSlug: 'notebook', name: 'Samsung Sala' });
  });

  test('enquanto o computador procura, a folha avisa e já deixa escolher', async ({ page }) => {
    identity.role = 'owner';
    tv.tvs = [{ ...CASA }];
    system.computers.push({ ...PC_CASA }, { ...NOTEBOOK });
    system.current = PC_CASA.slug;
    system.source = 'saved';
    let release!: () => void;
    tv.nearbyGate = new Promise<void>((resolve) => (release = resolve));
    await openSystem(page);

    await page.getByRole('button', { name: /Adicionar/ }).click();
    const nova = page.getByRole('dialog', { name: 'Nova TV' });
    await expect(nova.getByText('Procurando TVs…')).toBeVisible();
    // A lista de computadores já está lá: a procura nunca bloqueia o salvamento.
    await expect(nova.locator('label.choice').first()).toContainText('Notebook da sala');
    release();
    await expect(nova.getByText('Procurando TVs…')).toBeHidden();
    // Nada achado: sem bloco Na Sua Rede e a lista continua a de sempre.
    await expect(nova.getByText('TVs Encontradas', { exact: true })).toHaveCount(0);
    await expect(nova.getByText('Na Sua Rede', { exact: true })).toHaveCount(0);
  });
});
