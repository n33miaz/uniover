import { Page } from '@playwright/test';
import { IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, test } from '../fixtures';
import { settle } from '../screens/screen-helpers';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { PcMock, mockPcApi } from './pc-mock';
import { byeRtc, dropRtc, installFakeRtc, rtcLog } from './rtc-fake';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

let identity: IdentityMock;
let pc: PcMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  pc = await mockPcApi(context, identity);
  pc.status = { ...pc.status, capabilities: ['pc.rtc.v1'] };
  await mockTvApi(context, identity);
  await installFakeEventSource(page);
});

const status = (page: Page) => page.getByRole('status').filter({ hasText: /Conectado|Sem/ });

async function openPc(page: Page) {
  await page.goto('/pc');
  await expect(page.getByRole('heading', { level: 1, name: 'Controle do PC' })).toBeVisible();
  await expect(status(page)).toContainText('Conectado');
  await settle(page);
}

async function padCenter(page: Page) {
  const box = (await page.locator('.pad').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function tap(page: Page, x: number, y: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

async function swipe(page: Page, x: number, y: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step++) await page.mouse.move(x + step * 12, y + step * 4);
  await page.mouse.up();
}

test.describe('Canal direto', () => {
  test('sem WebRTC no navegador a nuvem faz tudo, sem tentar o canal e sem aviso', async ({
    page,
  }) => {
    await installFakeRtc(page, { remove: true });
    await openPc(page);
    const { x, y } = await padCenter(page);

    await swipe(page, x, y);
    await tap(page, x, y);

    await expect.poll(() => pc.sent('/click')).toEqual([{ button: 'LEFT' }]);
    await expect.poll(() => pc.sent('/pointer').length).toBeGreaterThan(0);
    expect(pc.requests.filter((r) => r.path.startsWith('/rtc'))).toEqual([]);
    await expect(status(page)).toHaveText('Conectado');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('o PC que não declara o canal nem recebe tentativa (o resto segue igual)', async ({
    page,
  }) => {
    await installFakeRtc(page);
    pc.status = { ...pc.status, capabilities: [] };
    await openPc(page);
    await settle(page);

    expect(pc.requests.filter((r) => r.path.startsWith('/rtc'))).toEqual([]);
    expect((await rtcLog(page))?.connections).toBe(0);
    await expect(status(page)).toHaveText('Conectado');
  });

  test('com o canal aberto o ponteiro e os cliques saem por ele e a nuvem fica quieta', async ({
    page,
  }) => {
    await installFakeRtc(page);
    await openPc(page);
    await expect(status(page)).toHaveText('Conectado, direto');
    await expect(page.locator('.status')).toHaveAttribute('data-transport', 'direct');
    const { x, y } = await padCenter(page);

    await swipe(page, x, y);
    await tap(page, x, y);

    await expect
      .poll(async () => (await rtcLog(page))?.input.filter((m) => m['k'] === 'cmd').length)
      .toBe(1);
    const log = (await rtcLog(page))!;
    // O token que a API emitiu é a primeira mensagem do canal de entrada.
    expect(log.input[0]).toEqual({ k: 'auth', tok: 'token-de-teste-0123456789abcdefghijklmnop' });
    expect(log.input.find((m) => m['k'] === 'cmd')).toMatchObject({
      t: 'pc.click.v1',
      b: { button: 'LEFT' },
    });
    const pointer = log.pointer.filter((m) => m['k'] === 'ptr');
    expect(pointer.length).toBeGreaterThan(0);
    const last = pointer.at(-1)!;
    expect(Number(last['x'])).toBeGreaterThanOrEqual(72);
    expect(Number(last['y'])).toBeGreaterThanOrEqual(24);
    // Nenhum movimento nem clique foi pela nuvem; só a sinalização (a oferta) passou pela API.
    expect(pc.sent('/pointer')).toEqual([]);
    expect(pc.sent('/click')).toEqual([]);
    expect(pc.sent('/rtc/offer')).toHaveLength(1);
  });

  test('se o canal cai, a nuvem assume na hora, sem aviso na tela', async ({ page }) => {
    await installFakeRtc(page);
    await openPc(page);
    await expect(status(page)).toHaveText('Conectado, direto');
    const { x, y } = await padCenter(page);
    await tap(page, x, y);
    await expect
      .poll(async () => (await rtcLog(page))?.input.filter((m) => m['k'] === 'cmd').length)
      .toBe(1);

    await dropRtc(page);
    await expect(status(page)).toHaveText('Conectado');
    await expect(page.locator('.status')).toHaveAttribute('data-transport', 'cloud');

    await tap(page, x, y);
    await expect.poll(() => pc.sent('/click')).toEqual([{ button: 'LEFT' }]);
    await swipe(page, x, y);
    await expect.poll(() => pc.sent('/pointer').length).toBeGreaterThan(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    // O canal que caiu avisou a API de que a sessão acabou (a trilha de fechamento).
    await expect
      .poll(() => pc.sent('/rtc/0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e01/close').length)
      .toBe(1);
  });

  test('outro aparelho tomar o canal (replaced) devolve tudo à nuvem, sem aviso e sem insistir', async ({
    page,
  }) => {
    await installFakeRtc(page);
    await openPc(page);
    await expect(status(page)).toHaveText('Conectado, direto');
    const { x, y } = await padCenter(page);
    await tap(page, x, y);
    await expect
      .poll(async () => (await rtcLog(page))?.input.filter((m) => m['k'] === 'cmd').length)
      .toBe(1);

    await byeRtc(page, 'replaced');
    await expect(status(page)).toHaveText('Conectado');

    await tap(page, x, y);
    await expect.poll(() => pc.sent('/click')).toEqual([{ button: 'LEFT' }]);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect((await rtcLog(page))?.connections).toBe(1);
  });

  test('a API recusar a oferta (409) mantém tudo pela nuvem, sem aviso', async ({ page }) => {
    await installFakeRtc(page);
    pc.rtcOfferFailure = { status: 409, kind: 'pc-direct-unavailable' };
    await openPc(page);
    await expect.poll(() => pc.sent('/rtc/offer').length).toBe(1);
    const { x, y } = await padCenter(page);

    await tap(page, x, y);

    await expect.poll(() => pc.sent('/click')).toEqual([{ button: 'LEFT' }]);
    await expect(status(page)).toHaveText('Conectado');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect((await rtcLog(page))?.input.filter((m) => m['k'] === 'cmd')).toEqual([]);
  });

  test('sair da tela do PC fecha o canal e avisa a API', async ({ page }) => {
    await installFakeRtc(page);
    await openPc(page);
    await expect(status(page)).toHaveText('Conectado, direto');

    // Navegação dentro do app (o roteador), sem recarregar: é a tela do PC que sai, não a página.
    await page.evaluate(() => {
      window.history.pushState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect
      .poll(() => pc.sent('/rtc/0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e01/close').length)
      .toBe(1);
  });
});
