import { join } from 'node:path';
import { Page } from '@playwright/test';
import { GUEST, IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { HOT_STATE, TvMock, emitSse, installFakeEventSource, mockTvApi, sseUrls } from './tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints (o orquestrador aponta uma pasta); sem a variável, ficam em `test-results`. */
const SHOTS = process.env['TV_PERMISSIONS_SHOTS'] ?? 'test-results';

/**
 * As combinações de permissões que a tela da TV tem de tratar como um produto completo (não como um app quebrado).
 * O servidor já recusa cada chamada fora da permissão (403); aqui se afirma o que a tela faz: não mostra o que a pessoa
 * não pode e, por isso, nunca faz a chamada que o servidor recusaria (`tv.denied` fica vazio, e os pedidos feitos são
 * os esperados). O mock da API responde 403 como a real, então uma chamada perdida falha alto.
 */
const CONTROL_ONLY = ['module:tv', 'tv:control'];
const LAUNCH_AND_EDIT = ['module:tv', 'tv:launch', 'tv:edit-shortcuts'];
const VIEW_ONLY = ['module:tv'];
const TRAINING_ONLY = ['module:training'];

const VIEW_ONLY_TEXT = 'Você pode ver a TV, mas não controlá-la.';

let identity: IdentityMock;
let tv: TvMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  tv = await mockTvApi(context, identity);
  await installFakeEventSource(page);
});

/** A conta da sessão aberta: o dono (tudo) ou uma convidada com a lista dada, como o `/me` a devolveria. */
function signInWith(permissions: readonly string[] | 'owner') {
  if (permissions === 'owner') {
    identity.role = 'owner';
  } else {
    identity.guests.push({
      id: '00000000-0000-4000-8000-000000000051',
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: [...permissions],
    });
    identity.role = 'guest';
  }
  identity.loggedIn = true;
}

/** Espera o fluxo abrir (o sinal de que a tela começou a falar com o servidor) e entrega o instantâneo de sempre. */
async function showTv(page: Page) {
  await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
  await emitSse(page, 'tv.state', tv.state);
  await emitSse(page, 'tv.shortcuts', tv.shortcuts);
  await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
  await settle(page);
}

async function openTvAs(page: Page, permissions: readonly string[] | 'owner') {
  signInWith(permissions);
  await page.goto('/tv');
  await showTv(page);
}

const header = (page: Page) => page.locator('.tv > header.head');
const power = (page: Page) => header(page).getByRole('button', { name: 'Desligar a TV' });
/** Os três pontos do cabeçalho: o menu com as linhas que a conta pode usar (ele nem existe para quem só vê). */
const menuButton = (page: Page) =>
  header(page).getByRole('button', { name: 'Mais opções', exact: true });
const menuDialog = (page: Page) => page.getByRole('dialog', { name: 'Mais opções' });
const menuRow = (page: Page, name: string) =>
  menuDialog(page).getByRole('button', { name, exact: true });
/** Abre o menu e toca na linha: o menu sai e o painel dela abre (um modal por vez). */
async function openMenuRow(page: Page, name: string) {
  await menuButton(page).click();
  await expect(menuDialog(page)).toBeVisible();
  await menuRow(page, name).click();
  await expect(menuDialog(page)).toHaveCount(0);
}
const titleButton = (page: Page) => header(page).getByRole('button', { name: /personalizar/ });
const okButton = (page: Page) => page.getByRole('button', { name: 'OK', exact: true });

/** Os pedidos da TV que não são leitura (comandos, edição): quem só vê não faz nenhum. */
const writes = () => tv.requests.filter((request) => request.method !== 'GET');

/**
 * Faz o que a aba faz sozinha ao voltar para a tela e ao voltar a rede (ler o estado e aquecer a sessão) e espera pela
 * leitura do estado, que sai junto, para o que vier depois valer sobre algo que já aconteceu (e não sobre o tempo).
 */
async function wakeUpTheTab(page: Page) {
  const before = tv.requests.filter((r) => r.method === 'GET' && r.path === '/state').length;
  await page.evaluate(() => {
    const visibility = (value: string) => {
      Object.defineProperty(document, 'visibilityState', { value, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    visibility('hidden');
    visibility('visible');
    window.dispatchEvent(new Event('online'));
  });
  await expect
    .poll(() => tv.requests.filter((r) => r.method === 'GET' && r.path === '/state').length)
    .toBeGreaterThan(before);
}

/**
 * Põe o tema do sistema e o movimento reduzido e espera o app acompanhar (ele copia o tema para `data-theme` quando o
 * navegador avisa a mudança, um instante depois), para o axe e o print verem o tema pedido e uma tela parada.
 */
async function useScheme(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
  await settle(page);
}

/** Não rola na horizontal, nenhum alvo de toque abaixo de 44 px e o axe não acha nada, nos dois temas. */
async function expectSound(page: Page) {
  await expectNoHorizontalScroll(page);
  expect(await smallTargets(page)).toEqual([]);
  for (const scheme of ['light', 'dark'] as const) {
    await useScheme(page, scheme);
    await expectNoA11yViolations(page);
  }
}

async function shoot(page: Page, name: string, project: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await useScheme(page, scheme);
    await screenshot(page, join(SHOTS, `${name}-${scheme}-${project}.png`));
  }
}

test.describe('(a) ver e controlar, sem desligar e sem Apps', () => {
  test('o controle inteiro aparece; desligar e a grade de Apps não; os atalhos são figuras', async ({
    page,
  }, info) => {
    await openTvAs(page, CONTROL_ONLY);

    await expect(okButton(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mudo', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Teclado', exact: true })).toBeVisible();
    await expect(power(page)).toHaveCount(0);
    // Sem abrir apps nem editar atalhos não há "Apps da TV", mas os três pontos ficam: a limpeza da TV mora neles.
    await menuButton(page).click();
    await expect(menuRow(page, 'Apps da TV')).toHaveCount(0);
    await expect(menuRow(page, 'Opções da TV')).toBeVisible();
    await expect(menuRow(page, 'Personalizar')).toBeVisible();
    // Trocar a computador da TV é do administrador: a conta convidada não vê nem o aviso "Afeta todos".
    await expect(menuDialog(page).getByText('Afeta todos')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menuDialog(page)).toHaveCount(0);
    await expect(page.getByText(VIEW_ONLY_TEXT, { exact: true })).toHaveCount(0);
    // O nome ainda abre Personalizar (a folha só faz sentido com o controle).
    await expect(titleButton(page)).toBeVisible();

    // Sem abrir apps, os atalhos de cima são só figuras: nada que pareça ou aja como botão.
    await expect(page.locator('.shortcuts .shortcut')).toHaveCount(3);
    await expect(page.locator('.shortcuts button')).toHaveCount(0);
    await expect(page.locator('.shortcuts .shortcut.still')).toHaveCount(3);
    await page.locator('.shortcuts .shortcut').first().click({ force: true });

    // O controle funciona: a tecla sai.
    await page.getByRole('button', { name: 'Mudo', exact: true }).click();
    await expect.poll(() => tv.keysSent()).toEqual(['MUTE']);

    // O teclado abre, e Personalizar também.
    await page.getByRole('button', { name: 'Teclado', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Teclado' })).toBeVisible();
    await page.getByRole('button', { name: 'Fechar' }).click();
    await expect(page.getByRole('dialog', { name: 'Teclado' })).toHaveCount(0);
    await titleButton(page).click();
    await expect(page.getByRole('dialog', { name: 'Personalizar' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Personalizar' })).toHaveCount(0);

    await shoot(page, 'a-controle', info.project.name);
    await expectSound(page);
    expect(tv.denied).toEqual([]);
  });

  test('os três pontos abrem um painel curto só com "Limpar a TV", e a limpeza alcança a TV', async ({
    page,
  }, info) => {
    await openTvAs(page, CONTROL_ONLY);
    await openMenuRow(page, 'Opções da TV');
    const options = page.getByRole('dialog', { name: 'Opções da TV' });
    await expect(options).toBeVisible();
    await expect(options.getByRole('button', { name: 'Limpar a TV' })).toBeVisible();
    // Nada do que o painel de apps traz e que esta conta não pode usar.
    await expect(options.getByRole('button', { name: 'Atualizar lista' })).toHaveCount(0);
    await expect(options.getByRole('button', { name: 'Editar', exact: true })).toHaveCount(0);
    await expect(options.getByRole('searchbox')).toHaveCount(0);
    await expect(options.locator('.grid, .launch, .empty, h3')).toHaveCount(0);
    await settle(page);
    await shoot(page, 'a-opcoes', info.project.name);
    for (const scheme of ['light', 'dark'] as const) {
      await useScheme(page, scheme);
      await expectNoA11yViolations(page);
    }
    await expectNoHorizontalScroll(page);
    expect(await smallTargets(page)).toEqual([]);

    await options.getByRole('button', { name: 'Limpar a TV' }).click();
    const sheet = page.getByRole('dialog', { name: 'Limpar a TV?' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Limpar', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => tv.count('/cleanup')).toBe(1);
    await expect(options.getByText('Fechou 6 apps e liberou cerca de 380 MB.')).toBeVisible();

    // Só o que a permissão cobre saiu: ler, aquecer e limpar. Nada recusado foi chamado.
    const paths = new Set(writes().map((request) => `${request.method} ${request.path}`));
    expect([...paths].sort()).toEqual(['POST /cleanup', 'POST /wake']);
    expect(tv.denied).toEqual([]);
  });

  test('só faz as chamadas que a permissão cobre: lê, aquece e manda tecla; nada de abrir app, desligar ou editar', async ({
    page,
  }) => {
    await openTvAs(page, CONTROL_ONLY);
    await wakeUpTheTab(page);
    // O aquecimento (controle) sai pelos três caminhos: abrir a tela, voltar à aba e voltar a rede.
    await expect.poll(() => tv.count('/wake')).toBeGreaterThanOrEqual(3);
    await page.getByRole('button', { name: 'Mudo', exact: true }).click();
    await expect.poll(() => tv.keysSent()).toEqual(['MUTE']);

    const paths = new Set(writes().map((request) => `${request.method} ${request.path}`));
    expect([...paths].sort()).toEqual(['POST /keys', 'POST /wake']);
    expect(tv.denied).toEqual([]);
  });

  test('os endereços antigos abrem o painel curto de opções e o teclado, e tiram o parâmetro do endereço', async ({
    page,
  }) => {
    signInWith(CONTROL_ONLY);
    await page.goto('/tv/apps');
    await showTv(page);
    await expect(page).toHaveURL(/\/tv$/);
    // Sem a grade de apps: o painel que abre é o das opções.
    await expect(page.getByRole('dialog', { name: 'Opções da TV' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Apps da TV' })).toHaveCount(0);

    await page.goto('/tv/teclado');
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await expect(page.getByRole('dialog', { name: 'Teclado' })).toBeVisible();
    await expect(page).toHaveURL(/\/tv$/);
    expect(tv.denied).toEqual([]);
  });
});

test.describe('(b) abrir apps e editar atalhos, sem controle', () => {
  test('a mensagem e os atalhos; Apps no cabeçalho; sem controle, sem desligar, e o nome é só texto', async ({
    page,
  }, info) => {
    await openTvAs(page, LAUNCH_AND_EDIT);

    await expect(page.getByText(VIEW_ONLY_TEXT, { exact: true })).toBeVisible();
    await expect(okButton(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Mudo', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Teclado', exact: true })).toHaveCount(0);
    await expect(power(page)).toHaveCount(0);
    await expect(menuButton(page)).toBeVisible();
    // Sem controle o nome não abre Personalizar: é só o nome.
    await expect(titleButton(page)).toHaveCount(0);
    await expect(
      header(page).getByRole('heading', { level: 1, name: 'TV', exact: true }),
    ).toBeVisible();

    // Com tv:launch os atalhos abrem o app.
    await expect(page.locator('.shortcuts button.shortcut')).toHaveCount(3);
    await page.locator('.shortcuts button.shortcut').first().click();
    await expect.poll(() => tv.count(`/shortcuts/${tv.shortcuts[0].id}/launch`)).toBe(1);

    await shoot(page, 'b-atalhos', info.project.name);
    await expectSound(page);
    expect(tv.denied).toEqual([]);
  });

  test('o painel Apps: abre, atualiza a lista e edita; não limpa a TV', async ({ page }, info) => {
    await openTvAs(page, LAUNCH_AND_EDIT);
    await openMenuRow(page, 'Apps da TV');
    const apps = page.getByRole('dialog', { name: 'Apps da TV' });
    await expect(apps).toBeVisible();
    await expect(apps.getByRole('button', { name: 'Limpar a TV' })).toHaveCount(0);
    await expect(apps.getByRole('button', { name: 'Atualizar lista' })).toBeVisible();
    await expect(apps.getByRole('button', { name: 'Editar', exact: true })).toBeVisible();
    await expect(apps.locator('button.launch')).toHaveCount(3);
    await shoot(page, 'b-painel', info.project.name);

    await apps.getByRole('button', { name: 'Atualizar lista' }).click();
    await expect.poll(() => tv.count('/shortcuts/refresh')).toBe(1);

    // Editar: renomear e mudar a ordem, que a permissão de editar cobre.
    await apps.getByRole('button', { name: 'Editar', exact: true }).click();
    await apps.getByRole('button', { name: 'Renomear Atalho 2' }).click();
    await apps.getByLabel('Nome do atalho').fill('Sala');
    await apps.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect.poll(() => tv.requests.filter((r) => r.method === 'PATCH').length).toBe(1);
    await apps.getByRole('button', { name: 'Mover Atalho 1 para a direita' }).click();
    await expect
      .poll(
        () => tv.requests.filter((r) => r.method === 'PUT' && r.path === '/shortcuts/order').length,
      )
      .toBe(1);

    expect(tv.requests.some((r) => r.path === '/wake')).toBe(false);
    expect(tv.denied).toEqual([]);
  });

  test('sem controle nenhuma tecla, texto, limpeza nem aquecimento sai, nem ao voltar à aba', async ({
    page,
  }) => {
    await openTvAs(page, LAUNCH_AND_EDIT);
    await wakeUpTheTab(page);
    for (const path of ['/wake', '/keys', '/text', '/cleanup', '/power/off']) {
      expect(tv.count(path), path).toBe(0);
    }
    expect(tv.denied).toEqual([]);
  });
});

test.describe('(c) só ver', () => {
  test('uma frase no lugar do controle, os atalhos como figuras e nada além do estado para tocar', async ({
    page,
  }, info) => {
    await openTvAs(page, VIEW_ONLY);

    await expect(page.getByText(VIEW_ONLY_TEXT, { exact: true })).toBeVisible();
    await expect(okButton(page)).toHaveCount(0);
    await expect(power(page)).toHaveCount(0);
    await expect(menuButton(page)).toHaveCount(0);
    await expect(titleButton(page)).toHaveCount(0);
    await expect(page.locator('.shortcuts .shortcut.still')).toHaveCount(3);
    await expect(page.locator('.shortcuts button')).toHaveCount(0);
    // A única coisa tocável de verdade é o ponto de estado (e o botão redondo que leva aos Ajustes).
    await expect(page.locator('app-tv-page button')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Estado do controle/ })).toBeVisible();

    await shoot(page, 'c-ver', info.project.name);
    await expectSound(page);
    expect(tv.denied).toEqual([]);
  });

  test('só lê: fluxo, estado e atalhos, e nenhum pedido de escrita, nem ao voltar à aba ou a rede', async ({
    page,
  }) => {
    await openTvAs(page, VIEW_ONLY);
    await wakeUpTheTab(page);
    await expect
      .poll(() => tv.requests.filter((r) => r.path === '/shortcuts').length)
      .toBeGreaterThan(1);
    expect(writes()).toEqual([]);
    expect(tv.denied).toEqual([]);
  });

  test('o ponto de estado explica o estado, mas não oferece acordar o controle', async ({
    page,
  }) => {
    await openTvAs(page, VIEW_ONLY);
    await emitSse(page, 'tv.state', { ...HOT_STATE, connection: 'hibernating' });
    const dot = page.getByRole('button', { name: 'Estado do controle: Dormindo' });
    await expect(dot).toBeVisible();
    await dot.click();
    const panel = page.getByRole('dialog').filter({ hasText: 'Dormindo' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button')).toHaveCount(0);
    // Só conta o estado: nada de "toque" nem de acordar, que quem só vê não pode fazer.
    await expect(panel).toContainText('Só o controle está dormindo para poupar a TV');
    await expect(panel).not.toContainText('toque');
    await expect(panel).not.toContainText('acorda');
    expect(writes()).toEqual([]);
  });

  test('os endereços antigos do teclado e dos apps não abrem nada', async ({ page }) => {
    signInWith(VIEW_ONLY);
    await page.goto('/tv/teclado');
    await showTv(page);
    await expect(page).toHaveURL(/\/tv$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.goto('/tv/apps');
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await expect(page).toHaveURL(/\/tv$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('(d) tudo, como o dono', () => {
  test('a tela de sempre: controle, Apps, desligar, atalhos que abrem e o nome que personaliza', async ({
    page,
  }, info) => {
    await openTvAs(page, 'owner');

    await expect(okButton(page)).toBeVisible();
    await expect(power(page)).toBeVisible();
    await expect(menuButton(page)).toBeVisible();
    await expect(titleButton(page)).toBeVisible();
    await expect(page.getByText(VIEW_ONLY_TEXT, { exact: true })).toHaveCount(0);
    await expect(page.locator('.shortcuts button.shortcut')).toHaveCount(3);

    await shoot(page, 'd-tudo', info.project.name);
    await expectSound(page);

    // Desligar, abrir app e editar, todos com a permissão do dono.
    await power(page).click();
    const sheet = page.getByRole('dialog', { name: 'Desligar a TV?' });
    await sheet.getByRole('button', { name: 'Desligar', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    expect(tv.count('/power/off')).toBe(1);

    await page.locator('.shortcuts button.shortcut').first().click();
    await expect.poll(() => tv.count(`/shortcuts/${tv.shortcuts[0].id}/launch`)).toBe(1);

    await openMenuRow(page, 'Apps da TV');
    const apps = page.getByRole('dialog', { name: 'Apps da TV' });
    await expect(apps.getByRole('button', { name: 'Limpar a TV' })).toBeVisible();
    await expect(apps.getByRole('button', { name: 'Atualizar lista' })).toBeVisible();
    await expect(apps.getByRole('button', { name: 'Editar', exact: true })).toBeVisible();
    expect(tv.denied).toEqual([]);
  });
});

test.describe('sem acesso à TV (só o Treino)', () => {
  test('o endereço da TV leva à Início: sem fluxo, sem estado, sem atalhos, nenhuma chamada', async ({
    page,
  }) => {
    signInWith(TRAINING_ONLY);
    await page.goto('/tv');
    // A guarda do módulo manda quem não tem a TV para a Início, e a Início mostra só o Treino.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('article[data-module="training"] a.card-link')).toBeVisible();
    await expect(page.locator('article[data-module="tv"] a.card-link')).toHaveCount(0);
    await expect(okButton(page)).toHaveCount(0);
    await expect(power(page)).toHaveCount(0);
    await expect(menuButton(page)).toHaveCount(0);
    await settle(page);
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);

    // Daí em diante nada deve ter saído para a API da TV.
    expect(await sseUrls(page)).toEqual([]);
    expect(tv.requests).toEqual([]);
    expect(tv.denied).toEqual([]);
  });
});

test.describe('mudança de permissão', () => {
  test('a lista nova vale quando a sessão a relê (ao recarregar): a tela encolhe sem 403', async ({
    page,
  }) => {
    await openTvAs(page, ['module:tv', 'tv:control', 'tv:power', 'tv:launch']);
    await expect(power(page)).toBeVisible();
    await expect(menuButton(page)).toBeVisible();

    // O administrador tirou o desligar e o abrir apps: a sessão só lê a lista de novo ao recarregar.
    identity.guests.at(-1)!.permissions = ['module:tv', 'tv:control'];
    await page.reload();
    await showTv(page);
    await expect(power(page)).toHaveCount(0);
    await menuButton(page).click();
    await expect(menuRow(page, 'Apps da TV')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menuDialog(page)).toHaveCount(0);
    await expect(okButton(page)).toBeVisible();

    identity.guests.at(-1)!.permissions = ['module:tv'];
    await page.reload();
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await expect(page.getByText(VIEW_ONLY_TEXT, { exact: true })).toBeVisible();
    await expect(okButton(page)).toHaveCount(0);
    expect(tv.denied).toEqual([]);
  });
});
