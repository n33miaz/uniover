import { join } from 'node:path';
import { Locator, Page } from '@playwright/test';
import { IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { TvMock, emitSse, installFakeEventSource, mockTvApi, sseUrls } from './tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints (quem roda o teste aponta uma pasta); sem a variável, ficam em `test-results`. */
const SHOTS = process.env['TV_ADB_PERMISSION_SHOTS'] ?? 'test-results';

const UNAUTHORIZED = {
  status: 502,
  kind: 'command-failed',
  extra: { agentError: 'adb_unauthorized' },
} as const;

let identity: IdentityMock;
let tv: TvMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  tv = await mockTvApi(context, identity);
  await installFakeEventSource(page);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
});

async function openTv(page: Page): Promise<void> {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/tv');
  await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
  await emitSse(page, 'tv.state', tv.state);
  await emitSse(page, 'tv.shortcuts', tv.shortcuts);
}

const button = (root: Page | Locator, name: string) =>
  root.getByRole('button', { name, exact: true });
const sheet = (page: Page) => page.locator('app-tv-adb-permission .sheet');
const notice = (page: Page) => page.locator('app-tv-adb-permission .notice:not(.notice-leave)');
const shortcut = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test.describe('a TV ainda não liberou o ADB', () => {
  test('o atalho recusado abre a folha, o controle segue usável e "Agora não" não insiste', async ({
    page,
  }, info) => {
    await openTv(page);
    tv.commandFailure = UNAUTHORIZED;
    await shortcut(page, 'Atalho 1').click();

    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByRole('heading', { level: 2 })).toHaveText('Liberar na TV');
    // Em vez de só mostrar o erro: nenhuma mensagem de erro em cima da folha.
    await expect(page.getByRole('alert')).toHaveCount(0);
    // Não é modal: o resto da tela não fica inerte e as teclas seguem saindo.
    tv.commandFailure = null;
    await button(page, 'OK').click();
    await expect.poll(() => tv.keysSent()).toContain('OK');
    // A folha não cobre a seta de cima: o toque na seta cai no botão dela, não na folha.
    const arrow = (await button(page, 'Para cima').locator('svg').boundingBox())!;
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'),
      { x: arrow.x + arrow.width / 2, y: arrow.y + arrow.height / 2 },
    );
    expect(hit).toBe('Para cima');
    await expect(button(page, 'Menu')).toBeEnabled();
    await settle(page);
    await expectNoHorizontalScroll(page);
    expect(await smallTargets(page)).toEqual([]);
    await expectNoA11yViolations(page);
    if (info.project.name === 'iphone-12') {
      await screenshot(page, join(SHOTS, 'tv-adb-permission-sheet-iphone-12-light.png'));
    }

    await button(sheet(page), 'Agora não').click();
    await expect(sheet(page)).toBeHidden();
    // Os atalhos mostram o sinal discreto, e uma nova recusa vira só o aviso curto (a folha não volta).
    await expect(shortcut(page, 'Atalho 1, precisa de permissão')).toBeVisible();
    tv.commandFailure = UNAUTHORIZED;
    await shortcut(page, 'Atalho 2, precisa de permissão').click();
    await expect(page.getByRole('alert')).toHaveText(
      'A TV ainda não liberou o UniOver. Toque em Atualizar lista.',
    );
    await expect(sheet(page)).toBeHidden();
  });

  test('Pedir na TV deixa o recado fixo até o aceite, e depois prova a permissão uma vez', async ({
    page,
  }, info) => {
    await openTv(page);
    tv.commandFailure = UNAUTHORIZED;
    await shortcut(page, 'Atalho 1').click();
    await expect(sheet(page)).toBeVisible();

    // O agente deixa o aviso na TV: o pedido volta recusado (é o aviso), e o estado conta que está pendente.
    await button(sheet(page), 'Pedir na TV').click();
    await expect.poll(() => tv.count('/shortcuts/refresh')).toBe(1);
    await expect(sheet(page)).toBeHidden();
    await emitSse(page, 'tv.state', { ...tv.state, adbPermission: 'pending' });
    await expect(notice(page)).toContainText('Aceite na TV e marque Sempre permitir');
    // O recado não pega o toque: o controle por baixo continua usável enquanto se aceita na TV.
    tv.commandFailure = null;
    await button(page, 'OK').click();
    await expect.poll(() => tv.keysSent()).toContain('OK');
    await settle(page);
    await expectNoHorizontalScroll(page);
    if (info.project.name === 'iphone-12') {
      await screenshot(page, join(SHOTS, 'tv-adb-permission-notice-iphone-12-light.png'));
    }

    // A TV aceitou: o agente conta `granted`, e o app faz mais um pedido de lista (a prova) e mostra "Pronto".
    await emitSse(page, 'tv.state', { ...tv.state, adbPermission: 'granted' });
    await expect(notice(page)).toContainText('Pronto');
    await expect.poll(() => tv.count('/shortcuts/refresh')).toBe(2);
    await expect(page.locator('.shortcut.needs-permission')).toHaveCount(0);
  });

  test('se ninguém aceita na TV, a folha volta dizendo isso', async ({ page }) => {
    await openTv(page);
    tv.commandFailure = UNAUTHORIZED;
    await shortcut(page, 'Atalho 1').click();
    await button(sheet(page), 'Pedir na TV').click();
    await emitSse(page, 'tv.state', { ...tv.state, adbPermission: 'pending' });
    await expect(notice(page)).toBeVisible();
    await emitSse(page, 'tv.state', { ...tv.state, adbPermission: 'missing' });
    await expect(notice(page)).toBeHidden();
    await expect(sheet(page)).toContainText('Ninguém aceitou na TV');
    await expect(button(sheet(page), 'Pedir na TV')).toBeVisible();
  });

  test('o estado "falta" abre a folha sozinho, e com "granted" nada aparece', async ({ page }) => {
    await openTv(page);
    await emitSse(page, 'tv.state', { ...tv.state, adbPermission: 'granted' });
    await expect(sheet(page)).toBeHidden();
    await emitSse(page, 'tv.state', { ...tv.state, adbPermission: 'missing' });
    await expect(sheet(page)).toBeVisible();
    // Só abrir a folha nunca pede nada à TV: o pedido é o toque em "Pedir na TV".
    expect(tv.count('/shortcuts/refresh')).toBe(0);
  });

  test('Atualizar lista é o próprio pedido: sem folha, só o recado do aceite', async ({ page }) => {
    await openTv(page);
    tv.commandFailure = UNAUTHORIZED;
    await page.getByRole('button', { name: 'Mais opções' }).click();
    await page.getByRole('button', { name: /Apps da TV/ }).click();
    await page.getByRole('button', { name: /Atualizar lista/ }).click();
    await expect.poll(() => tv.count('/shortcuts/refresh')).toBe(1);
    await emitSse(page, 'tv.state', { ...tv.state, adbPermission: 'pending' });
    await expect(notice(page)).toContainText('Aceite na TV e marque Sempre permitir');
    await expect(sheet(page)).toBeHidden();
    // Aceito na TV: o mesmo toque ganha a prova (mais um pedido de lista), e os atalhos deixam de pedir permissão.
    tv.commandFailure = null;
    await emitSse(page, 'tv.state', { ...tv.state, adbPermission: 'granted' });
    await expect.poll(() => tv.count('/shortcuts/refresh')).toBe(2);
    await expect(page.locator('.shortcut.needs-permission')).toHaveCount(0);
  });
});
