import { join } from 'node:path';
import { Page, TestInfo } from '@playwright/test';
import { IdentityMock, MockGuest, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { MockTv, SHORTCUTS, TvMock, installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { MockSiriKey, SiriMock, mockSiriApi } from './siri-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints (o orquestrador aponta uma pasta); sem a variável, ficam em `test-results`. */
const SHOTS = process.env['SIRI_SHOTS'] ?? 'test-results';

const SALA: MockTv = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Sala',
  isDefault: true,
  agentSlug: 'pc-casa',
  kind: 'android',
  online: true,
  capabilities: ['tv.remote', 'tv.kind.android', 'tv.adb', 'tv.power.off.v1'],
};

const OLD_KEY: MockSiriKey = {
  id: 'key-0',
  name: 'iPhone do dono',
  tvId: SALA.id,
  tvName: 'Sala',
  actions: ['power_off', 'volume_up', 'volume_down', 'mute'],
  createdAt: '2026-10-20T12:00:00Z',
  expiresAt: '2027-01-20T12:00:00Z',
  lastUsedAt: '2026-10-30T22:15:00Z',
};

const BIA: MockGuest = {
  id: '00000000-0000-4000-8000-0000000000b2',
  displayName: 'Bia',
  email: 'bia@exemplo.com',
  password: 'x',
  createdAt: '2026-10-12T10:00:00Z',
  disabledAt: null,
};

let identity: IdentityMock;
let tv: TvMock;
let siri: SiriMock;

test.beforeEach(async ({ context, page, browserName }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  // A confirmação com a passkey vale (o WebKit do Playwright não tem autenticador virtual); a recusa dela é da API e dos testes unitários.
  identity.stepUpValid = true;
  tv = await mockTvApi(context, identity);
  tv.tvs = [{ ...SALA }];
  tv.shortcuts = SHORTCUTS.map((shortcut, index) => ({
    ...shortcut,
    tvLabel: ['Vídeo', 'Música', 'Jogos'][index] ?? null,
  }));
  // Depois do mock da TV: a rota registrada por último vence, e as duas moram sob o mesmo prefixo.
  siri = await mockSiriApi(context, identity);
  siri.tvNames[SALA.id] = 'Sala';
  await installFakeEventSource(page);
  // O Chromium só deixa a página escrever na área de transferência com permissão; o WebKit não tem essa permissão, e lá a
  // tela mostra o aviso de que não deu para copiar (os dois resultados são aceitos no teste).
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  }
});

async function open(page: Page, path = '/ajustes/seguranca/siri') {
  // Movimento reduzido: as animações de entrada saem do caminho e o axe mede as cores finais (o executor da CI é lento).
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: 'Atalhos da Siri' })).toBeVisible();
}

const shot = (info: TestInfo, name: string) => join(SHOTS, `${name}-${info.project.name}.png`);

/** O roteiro de toda tela: sem rolagem de lado, print, alvos de 44 px e o axe sem nenhuma violação. */
async function check(page: Page, info: TestInfo, name: string) {
  await settle(page);
  await expectNoHorizontalScroll(page);
  await screenshot(page, shot(info, name));
  expect(await smallTargets(page)).toEqual([]);
  await expectNoA11yViolations(page);
}

test.describe('Configurações > Segurança > Atalhos da Siri', () => {
  test('a Segurança leva à tela dos atalhos, e o convidado nem vê a linha', async ({ page }) => {
    await page.goto('/ajustes/seguranca');
    await page.getByRole('link', { name: /Atalhos da Siri/ }).click();
    await expect(page).toHaveURL(/\/ajustes\/seguranca\/siri$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Atalhos da Siri' })).toBeVisible();
  });

  test('o convidado não alcança a tela e não vê a linha na Segurança', async ({ page }) => {
    identity.guests.push({ ...BIA, permissions: ['module:tv', 'tv:control'] });
    identity.role = 'guest';
    await page.goto('/ajustes/seguranca');
    await expect(page.getByRole('heading', { level: 1, name: 'Segurança' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Atalhos da Siri/ })).toHaveCount(0);
    await page.goto('/ajustes/seguranca/siri');
    await expect(page).not.toHaveURL(/\/siri$/);
    expect(siri.requests).toEqual([]);
  });

  test('lista a chave que já existe, sem o segredo, e mostra como montar com o lugar da chave marcado', async ({
    page,
  }, info) => {
    siri.keys.push({ ...OLD_KEY });
    await open(page);
    const item = page.locator('li.item', { hasText: 'iPhone do dono' });
    await expect(item).toContainText('Sala · Desligar a TV, Aumentar o volume e mais 2');
    await expect(item).toContainText('Última vez');
    await expect(item).toContainText('Vale até');

    await item.getByRole('button', { name: 'Como montar iPhone do dono' }).click();
    await item.locator('app-siri-steps .phrase').first().click();
    await expect(item.getByText('<sua chave>').first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText('atalho_');
    await check(page, info, 'siri-lista');
  });

  test('cria uma chave: escolhe as ações, mostra o segredo uma vez e os passos já com a chave', async ({
    page,
  }, info) => {
    await open(page);
    await page.getByRole('button', { name: 'Criar chave' }).click();
    await expect(page.getByRole('heading', { name: 'Nova chave' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Criar chave' })).toBeDisabled();

    await page.getByRole('switch', { name: 'Desligar a TV' }).check();
    await page.getByRole('switch', { name: 'Aumentar o volume' }).check();
    await page.getByRole('switch', { name: 'Vídeo' }).check();
    await page.getByText('90 dias').click();
    await expect(page.getByRole('button', { name: 'Criar chave' })).toBeEnabled();
    await page.getByRole('button', { name: 'Criar chave' }).scrollIntoViewIfNeeded();
    await check(page, info, 'siri-nova');

    await page.getByRole('button', { name: 'Criar chave' }).click();
    await expect(page.getByRole('heading', { name: 'Chave criada' })).toBeVisible();
    await expect(page.getByLabel('Chave dos atalhos')).toHaveValue('atalho_segredo-de-teste');

    const create = siri.requests.find((r) => r.method === 'POST')!;
    expect(create.body).toEqual({
      name: 'Meu iPhone',
      tvId: SALA.id,
      actions: ['power_off', 'volume_up', `app:${SHORTCUTS[0]!.id}`],
      expiresInDays: 90,
    });

    // Um cartão por ação, com a frase que se diz à Siri; abre um e confere o que colar.
    const phrases = page.locator('app-siri-steps .phrase');
    await expect(phrases).toHaveText([
      'Desligar a TV',
      'Aumentar o volume da TV',
      'Abrir Vídeo na TV',
    ]);
    await phrases.first().click();
    const card = page.locator('app-siri-steps li.card').first();
    await expect(card).toContainText('/api/v1/shortcuts/tv');
    await expect(card).toContainText('POST');
    await expect(card).toContainText('X-Atalho-Token');
    await expect(card).toContainText('atalho_segredo-de-teste');
    await expect(card).toContainText(SALA.id);
    await expect(card).toContainText('power_off');
    await card.scrollIntoViewIfNeeded();
    await check(page, info, 'siri-chave-criada');

    // Copiar vai para a área de transferência (quando o navegador deixa) e avisa na tela.
    await card.getByRole('button', { name: 'Copiar tudo' }).click();
    await expect(page.getByText(/Passo a passo copiado|Não deu para copiar sozinho/)).toBeVisible();

    // Concluir apaga o segredo da tela; a lista passa a ter a chave, sem ele.
    await page.getByRole('button', { name: 'Concluir' }).click();
    await expect(page.getByLabel('Chave dos atalhos')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('atalho_segredo-de-teste');
    await expect(page.locator('li.item', { hasText: 'Meu iPhone' })).toBeVisible();
  });

  test('revoga uma chave depois de perguntar', async ({ page }) => {
    siri.keys.push({ ...OLD_KEY });
    await open(page);
    await page.getByRole('button', { name: 'Revogar iPhone do dono' }).click();
    await expect(page.getByText(/param de funcionar/)).toBeVisible();
    expect(siri.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);

    await page.getByRole('button', { name: 'Revogar', exact: true }).click();
    await expect(page.getByText('Chave revogada.')).toBeVisible();
    await expect(page.locator('li.item')).toHaveCount(0);
    expect(siri.requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual([
      '/siri/tokens/key-0',
    ]);
  });
});
