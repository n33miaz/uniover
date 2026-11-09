import { join } from 'node:path';
import { Locator, Page } from '@playwright/test';
import { GUEST, IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
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

/**
 * O que o agente conta: fica no estado que a API devolve (o app o confere depois de um pedido recusado) e, com `push`,
 * chega também pelo fluxo de eventos.
 */
async function saysAgent(
  page: Page,
  adbPermission: 'granted' | 'missing' | 'pending',
  reason: string | null = null,
  push = true,
): Promise<void> {
  tv.state = { ...tv.state, adbPermission, adbPermissionReason: reason };
  if (push) await emitSse(page, 'tv.state', tv.state);
}

async function openTv(page: Page, who: { email: string; password: string } = OWNER): Promise<void> {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(who.email);
  await page.getByLabel('Senha', { exact: true }).fill(who.password);
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

    // O agente deixa o aviso na TV: o pedido volta recusado e o estado conta que está pendente.
    await saysAgent(page, 'pending', null, false);
    await button(sheet(page), 'Pedir na TV').click();
    await expect.poll(() => tv.count('/shortcuts/refresh')).toBe(1);
    await expect(sheet(page)).toBeHidden();
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
    await saysAgent(page, 'granted');
    await expect(notice(page)).toContainText('Pronto');
    await expect.poll(() => tv.count('/shortcuts/refresh')).toBe(2);
    await expect(page.locator('.shortcut.needs-permission')).toHaveCount(0);
  });

  test('sem o "pending" do agente não há recado: a folha diz que a TV não mostrou o pedido', async ({
    page,
  }) => {
    await openTv(page);
    tv.commandFailure = UNAUTHORIZED;
    await shortcut(page, 'Atalho 1').click();
    // O pedido volta recusado, mas o agente conta que nada foi pedido à TV (por exemplo, outro aparelho no endereço).
    await saysAgent(page, 'missing', 'tv_refused', false);
    await button(sheet(page), 'Pedir na TV').click();
    await expect(sheet(page)).toContainText('A TV não mostrou o pedido', { timeout: 10_000 });
    await expect(notice(page)).toBeHidden();
    await expect(button(sheet(page), 'Pedir na TV')).toBeVisible();
  });

  test('se ninguém aceita na TV, a folha volta dizendo isso', async ({ page }) => {
    await openTv(page);
    tv.commandFailure = UNAUTHORIZED;
    await shortcut(page, 'Atalho 1').click();
    await saysAgent(page, 'pending', null, false);
    await button(sheet(page), 'Pedir na TV').click();
    await expect(notice(page)).toBeVisible();
    await saysAgent(page, 'missing', 'prompt_expired');
    await expect(notice(page)).toBeHidden();
    await expect(sheet(page)).toContainText('Ninguém aceitou na TV');
    await expect(button(sheet(page), 'Pedir na TV')).toBeVisible();
  });

  test('só a TV que esqueceu a permissão abre a folha sozinha; uma nunca liberada não', async ({
    page,
  }) => {
    await openTv(page);
    await saysAgent(page, 'granted');
    await expect(sheet(page)).toBeHidden();
    await saysAgent(page, 'missing', 'never');
    await expect(sheet(page)).toBeHidden();
    await expect(shortcut(page, 'Atalho 1, precisa de permissão')).toBeVisible();
    await saysAgent(page, 'missing', 'tv_forgot');
    await expect(sheet(page)).toBeVisible();
    // Só abrir a folha nunca pede nada à TV: o pedido é o toque em "Pedir na TV".
    expect(tv.count('/shortcuts/refresh')).toBe(0);
  });

  test('"Agora não" vale por TV neste aparelho, mesmo recarregando o app', async ({ page }) => {
    await openTv(page);
    await saysAgent(page, 'missing', 'tv_forgot');
    await button(sheet(page), 'Agora não').click();
    await page.reload();
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await emitSse(page, 'tv.state', tv.state);
    await emitSse(page, 'tv.shortcuts', tv.shortcuts);
    await saysAgent(page, 'missing', 'tv_forgot');
    await expect(shortcut(page, 'Atalho 1, precisa de permissão')).toBeVisible();
    await expect(sheet(page)).toBeHidden();
  });

  test('Atualizar lista é o próprio pedido: sem folha, só o recado do aceite', async ({ page }) => {
    await openTv(page);
    tv.commandFailure = UNAUTHORIZED;
    await saysAgent(page, 'pending');
    await page.getByRole('button', { name: 'Mais opções' }).click();
    await page.getByRole('button', { name: /Apps da TV/ }).click();
    await page.getByRole('button', { name: /Atualizar lista/ }).click();
    await expect.poll(() => tv.count('/shortcuts/refresh')).toBe(1);
    await expect(notice(page)).toContainText('Aceite na TV e marque Sempre permitir');
    await expect(sheet(page)).toBeHidden();
    // Aceito na TV: o mesmo toque ganha a prova (mais um pedido de lista), e os atalhos deixam de pedir permissão.
    tv.commandFailure = null;
    await saysAgent(page, 'granted');
    await expect.poll(() => tv.count('/shortcuts/refresh')).toBe(2);
    await expect(page.locator('.shortcut.needs-permission')).toHaveCount(0);
  });

  test('outro aparelho no endereço: "É a mesma TV" pede confirmação, refaz o registro e segue com o pedido de sempre', async ({
    page,
  }) => {
    await openTv(page);
    tv.commandFailure = {
      status: 502,
      kind: 'command-failed',
      extra: { agentError: 'adb_device_changed' },
    };
    await shortcut(page, 'Atalho 1').click();
    await expect(sheet(page)).toContainText('Outro aparelho respondeu no endereço da TV');
    await expect(page.locator('app-tv-toast .toast')).toHaveCount(0); // sem o erro em cima da folha
    // Sem o pedido de permissão aqui (o agente se recusa a falar com esse aparelho): só a saída explícita.
    await expect(button(sheet(page), 'Pedir na TV')).toHaveCount(0);

    await button(sheet(page), 'É a mesma TV').click();
    await expect(sheet(page)).toContainText('Esta é a mesma TV? (ex.: trocou de Wi-Fi para cabo)');
    await expect(sheet(page)).toContainText(
      'A TV vai pedir permissão; aceite marcando Sempre permitir.',
    );
    expect(tv.count('/adb/rebind')).toBe(0); // nada foi enviado antes de confirmar
    await button(sheet(page), 'Não').click();
    await expect(sheet(page)).toContainText('Outro aparelho respondeu no endereço da TV');
    expect(tv.count('/adb/rebind')).toBe(0);

    // Confirmado: o registro é refeito e, em seguida, vem o pedido de permissão de sempre.
    tv.commandFailure = null;
    await button(sheet(page), 'É a mesma TV').click();
    await button(sheet(page), 'Sim, é a mesma').click();
    await expect.poll(() => tv.count('/adb/rebind')).toBe(1);
    await expect.poll(() => tv.count('/shortcuts/refresh')).toBe(1);
    await expect(sheet(page)).toBeHidden();
  });

  test('uma conta convidada, mesmo com o controle de apps, vê "Peça ao dono da TV" e não o botão', async ({
    page,
  }) => {
    identity.guests.push({
      id: '00000000-0000-4000-8000-000000000071',
      displayName: 'Convidada',
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:tv', 'tv:control', 'tv:launch'],
    });
    await openTv(page, GUEST);
    tv.commandFailure = {
      status: 502,
      kind: 'command-failed',
      extra: { agentError: 'adb_device_changed' },
    };
    await shortcut(page, 'Atalho 1').click();
    await expect(sheet(page)).toContainText('Peça ao dono da TV');
    await expect(button(sheet(page), 'É a mesma TV')).toHaveCount(0);
    await expect(button(sheet(page), 'Pedir na TV')).toHaveCount(0);
    expect(tv.count('/adb/rebind')).toBe(0);
  });

  test('registro apagado por um pareamento novo com outro aparelho: recado calmo, sem folha', async ({
    page,
  }) => {
    await openTv(page);
    await saysAgent(page, 'missing', 'registration_cleared');
    await expect(notice(page)).toContainText('Permissão apagada: a TV mudou');
    await expect(sheet(page)).toBeHidden();
  });
});
