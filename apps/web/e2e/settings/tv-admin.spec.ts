import { join } from 'node:path';
import { Page, TestInfo } from '@playwright/test';
import { IdentityMock, MockGuest, OWNER_ID, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { MockComputer, SystemMock, mockSystemApi } from '../system/system-mock';
import { MockTv, TvMock, installFakeEventSource, mockTvApi } from '../tv/tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints (o orquestrador aponta uma pasta); sem a variável, ficam em `test-results`. */
const SHOTS = process.env['TV_ADMIN_SHOTS'] ?? 'test-results';

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

const CASA: MockTv = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Sala',
  isDefault: true,
  agentSlug: 'pc-casa',
  kind: 'android',
  online: true,
  capabilities: [
    'tv.remote',
    'tv.kind.android',
    'tv.adb',
    'tv.light-settings.v1',
    'tv.focus-catalog.v1',
  ],
};
const RAPHAEL: MockTv = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Quarto',
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
  permissions: ['module:tv', 'tv:control', 'tv:power'],
};
const BIA: MockGuest = {
  id: '00000000-0000-4000-8000-0000000000b2',
  displayName: 'Bia',
  email: 'bia@exemplo.com',
  password: 'x',
  createdAt: '2026-10-12T10:00:00Z',
  disabledAt: null,
  permissions: ['module:tv'],
};
const SEM_TV: MockGuest = {
  id: '00000000-0000-4000-8000-0000000000b3',
  displayName: 'Cris',
  email: 'cris@exemplo.com',
  password: 'x',
  createdAt: '2026-10-14T10:00:00Z',
  disabledAt: null,
  permissions: ['module:training'],
};

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  identity.stepUpValid = true;
  identity.guests.push({ ...BRUNO }, { ...BIA }, { ...SEM_TV });
  tv = await mockTvApi(context, identity);
  system = await mockSystemApi(context, identity);
  await installFakeEventSource(page);
});

function seed(): void {
  tv.tvs = [
    {
      ...CASA,
      shortcuts: [
        ['com.google.android.youtube.tv', 'YouTube'],
        ['com.netflix.ninja', 'Netflix'],
        ['com.exemplo.cinema', 'Cine Exemplo'],
      ].map(([pkg, label], index) => ({
        id: `00000000-0000-4000-8000-00000000010${index}`,
        position: index + 1,
        package: pkg!,
        tvLabel: label!,
        customLabel: null,
        enabled: true,
        installed: true,
      })),
      history: [
        {
          id: 'h3',
          userId: BRUNO.id,
          command: 'tv.text',
          detail: 'length=5',
          ok: false,
          errorCode: 'TV_UNREACHABLE',
          occurredAt: '2026-10-31T21:40:00Z',
        },
        {
          id: 'h2',
          userId: OWNER_ID,
          command: 'tv.power-off',
          detail: null,
          ok: true,
          errorCode: null,
          occurredAt: '2026-10-31T21:10:00Z',
        },
        {
          id: 'h1',
          userId: BRUNO.id,
          command: 'tv.key',
          detail: 'VOLUME_UP/SHORT',
          ok: true,
          errorCode: null,
          occurredAt: '2026-10-31T20:55:00Z',
        },
      ],
    },
    { ...RAPHAEL },
  ];
  tv.members[RAPHAEL.id] = [BIA.id];
  system.computers.push({ ...PC_CASA }, { ...PC_RAPHAEL });
  system.current = PC_CASA.slug;
  system.source = 'saved';
}

const shot = (info: TestInfo, name: string) =>
  join(SHOTS, `tv-admin-${name}-${info.project.name}.png`);

/** O roteiro de toda tela: sem rolagem de lado, print, alvos de 44 px e o axe sem nenhuma violação. */
async function check(page: Page, info: TestInfo, name: string) {
  await settle(page);
  await expectNoHorizontalScroll(page);
  await screenshot(page, shot(info, name));
  expect(await smallTargets(page)).toEqual([]);
  await expectNoA11yViolations(page);
}

async function open(page: Page, path: string, heading: string) {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

const sheet = (page: Page) => page.locator('app-tv-edit-sheet dialog');
const requestsTo = (path: RegExp) => tv.requests.filter((r) => path.test(r.path));

test.describe('TVs por Pessoa', () => {
  test('mostra, por pessoa, as TVs que ela vê e o que faz nelas, com o computador só aqui', async ({
    page,
  }, info) => {
    seed();
    await page.goto('/ajustes');
    await page.getByRole('link', { name: 'TVs por Pessoa' }).click();
    await expect(page).toHaveURL(/\/ajustes\/tvs-por-pessoa$/);
    await expect(page.getByRole('heading', { level: 1, name: 'TVs por Pessoa' })).toBeVisible();

    const person = (name: string) => page.locator('li.person', { hasText: name });
    // O administrador vê e controla todas, com o computador de cada uma.
    await expect(person('Administrador')).toContainText('Sala');
    await expect(person('Administrador')).toContainText('PC de casa · Android');
    await expect(person('Administrador')).toContainText('Quarto');
    await expect(person('Administrador')).toContainText('PC do Raphael · Samsung');
    // Quem nunca foi marcado segue na padrão; quem foi marcado, só na dele.
    await expect(person('Bruno')).toContainText('Sala');
    await expect(person('Bruno')).toContainText('Controla');
    await expect(person('Bruno')).not.toContainText('Quarto');
    await expect(person('Bia')).toContainText('Quarto');
    await expect(person('Bia')).toContainText('Só Vê');
    await expect(person('Bia')).not.toContainText('Sala');
    await expect(person('Cris')).toContainText('Sem acesso à TV');
    expect(requestsTo(/^\/tvs\/access$/)).toHaveLength(1);
    await check(page, info, 'tvs-por-pessoa');
  });

  test('um erro de leitura mostra o aviso e tenta de novo', async ({ page }) => {
    seed();
    tv.tvs = null;
    await open(page, '/ajustes/tvs-por-pessoa', 'TVs por Pessoa');
    await expect(page.getByRole('alert')).toContainText('Não foi possível carregar agora.');
    await expect(page.getByRole('button', { name: 'Tentar de Novo' })).toBeVisible();
  });
});

test.describe('Histórico da TV', () => {
  test('abre da folha da TV e mostra quem, o quê, quando e se deu certo', async ({
    page,
  }, info) => {
    seed();
    await open(page, '/ajustes/sistema', 'Sistema');
    await page.locator('ul.tvs button.ui-row', { hasText: 'Sala' }).click();
    await sheet(page).getByRole('button', { name: 'Histórico' }).click();

    await expect(page).toHaveURL(new RegExp(`/ajustes/tv/${CASA.id}/historico$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Histórico' })).toBeVisible();
    const entries = page.locator('li.entry');
    await expect(entries).toHaveCount(3);
    await expect(entries.nth(0)).toContainText('Texto enviado à TV');
    await expect(entries.nth(0)).toContainText('5 caracteres');
    await expect(entries.nth(0)).toContainText('Bruno');
    await expect(entries.nth(0)).toContainText('Erro');
    await expect(entries.nth(1)).toContainText('TV desligada');
    await expect(entries.nth(1)).toContainText('Sucesso');
    await expect(entries.nth(2)).toContainText('Tecla volume up');
    await check(page, info, 'historico');
    expect(requestsTo(/^\/commands\/recent$/).map((r) => r.tvId)).toEqual([CASA.id]);
  });

  test('uma TV que não existe mais diz isso, sem listar nada', async ({ page }) => {
    seed();
    await open(page, '/ajustes/tv/99999999-9999-4999-8999-999999999999/historico', 'Histórico');
    await expect(page.getByRole('alert')).toContainText('Essa TV não existe mais.');
  });

  test('quem usa a TV não tem tela, rota, pedido nem texto sobre o histórico', async ({ page }) => {
    seed();
    identity.guests.length = 0;
    identity.guests.push({
      ...BRUNO,
      permissions: [
        'module:tv',
        'tv:control',
        'tv:power',
        'tv:launch',
        'tv:edit-shortcuts',
        'tv:history',
      ],
    });
    identity.role = 'guest';

    for (const path of [
      `/ajustes/tv/${CASA.id}/historico`,
      '/ajustes/tvs-por-pessoa',
      '/ajustes/sistema',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(new URL(page.url()).pathname, path).toBe('/');
    }
    await page.goto('/ajustes/perfil');
    await expect(page.getByText('Controlar a TV')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/hist[óo]rico/i);
    await page.goto('/tv');
    await expect(page.locator('body')).not.toContainText(/hist[óo]rico/i);

    expect(requestsTo(/^\/commands\/recent$/)).toEqual([]);
    expect(requestsTo(/^\/tvs\/access$/)).toEqual([]);
    expect(system.requests).toEqual([]);
  });

  test('a rota do histórico recusa o convidado com 403, mesmo com a permissão antiga, e registra a recusa', async ({
    page,
  }) => {
    seed();
    identity.guests.length = 0;
    identity.guests.push({ ...BRUNO, permissions: ['module:tv', 'tv:history'] });
    identity.role = 'guest';
    await page.goto('/tv');
    await page.waitForLoadState('networkidle');
    const token = identity.issuedTokens.at(-1)!;
    const status = await page.evaluate(
      async ({ id, bearer }) =>
        (
          await fetch(`/api/v1/tv/commands/recent?tvId=${id}`, {
            headers: { authorization: `Bearer ${bearer}` },
          })
        ).status,
      { id: CASA.id, bearer: token },
    );
    expect(status).toBe(403);
    expect(tv.denied.map((r) => r.path)).toContain('/commands/recent');
  });
});

test.describe('Catálogo do Modo Foco', () => {
  test('lista os apps do catálogo, deixa adicionar e tirar, e manda só o que mudou', async ({
    page,
  }, info) => {
    seed();
    await open(page, '/ajustes/sistema', 'Sistema');
    await page.locator('ul.tvs button.ui-row', { hasText: 'Sala' }).click();
    const dialog = sheet(page);
    await expect(dialog).toBeVisible();

    // Sem o Modo Foco ligado a lista não aparece.
    await expect(dialog.getByText('Apps do Modo Foco')).toHaveCount(0);
    await dialog.getByRole('switch', { name: 'Modo Foco' }).check();
    const catalog = dialog
      .locator('p.reports-title', { hasText: 'Apps do Modo Foco' })
      .locator('xpath=following-sibling::ul[1]');
    await expect(catalog).toBeVisible();
    // A lista de fábrica vem ligada (e um app dela que não está instalado também aparece, com o nome que a pessoa conhece).
    await expect(catalog.getByRole('switch', { name: 'YouTube' })).toBeChecked();
    await expect(catalog.getByRole('switch', { name: 'Netflix' })).toBeChecked();
    await expect(catalog.getByRole('switch', { name: 'Prime Video' })).toBeChecked();
    await expect(catalog.getByRole('switch', { name: 'Cine Exemplo' })).not.toBeChecked();

    await catalog.getByRole('switch', { name: 'Cine Exemplo' }).check();
    await catalog.getByRole('switch', { name: 'Netflix' }).uncheck();
    await catalog.scrollIntoViewIfNeeded();
    await check(page, info, 'catalogo-foco');

    await dialog.getByRole('button', { name: 'Salvar' }).click();
    await expect(dialog).toBeHidden();
    const patches = tv.requests.filter((r) => r.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual(
      expect.objectContaining({
        focusModeEnabled: true,
        focusPackages: expect.arrayContaining([
          'com.exemplo.cinema',
          'com.google.android.youtube.tv',
          'com.amazon.amazonvideo.livingroom',
        ]),
      }),
    );
    expect((patches[0]!.body as { focusPackages: string[] }).focusPackages).not.toContain(
      'com.netflix.ninja',
    );

    // Voltar ao padrão: a lista de fábrica volta inteira e o servidor deixa de guardar uma lista própria.
    await page.locator('ul.tvs button.ui-row', { hasText: 'Sala' }).click();
    await dialog.getByRole('switch', { name: 'Modo Foco' }).check();
    await dialog.getByRole('button', { name: 'Voltar ao Padrão' }).click();
    await expect(catalog.getByRole('switch', { name: 'Netflix' })).toBeChecked();
    await expect(catalog.getByRole('switch', { name: 'Cine Exemplo' })).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Salvar' }).click();
    await expect(dialog).toBeHidden();
    expect(tv.tvs![0]!.focusPackages).toBeUndefined();
  });

  test('o agente que não anuncia o catálogo não mostra a lista', async ({ page }) => {
    seed();
    tv.tvs![0]!.capabilities = ['tv.remote', 'tv.kind.android', 'tv.adb', 'tv.light-settings.v1'];
    await open(page, '/ajustes/sistema', 'Sistema');
    await page.locator('ul.tvs button.ui-row', { hasText: 'Sala' }).click();
    await sheet(page).getByRole('switch', { name: 'Modo Foco' }).check();
    await expect(sheet(page).getByText('Apps do Modo Foco')).toHaveCount(0);
  });
});
