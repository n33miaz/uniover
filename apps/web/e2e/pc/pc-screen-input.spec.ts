import { Page } from '@playwright/test';
import { IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, test } from '../fixtures';
import { settle } from '../screens/screen-helpers';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { PcMock, mockPcApi } from './pc-mock';
import { injectRtcScreenFrame, injectRtcScreenMonitors, installFakeRtc, rtcLog } from './rtc-fake';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

let identity: IdentityMock;
let pc: PcMock;

const TWO_MONITORS = [
  { id: 1, primary: true, width: 1920, height: 1080 },
  { id: 2, primary: false, width: 1280, height: 1024 },
];

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  pc = await mockPcApi(context, identity);
  pc.status = {
    ...pc.status,
    capabilities: ['pc.rtc.v1', 'pc.screen.v1', 'pc.abs.v1'],
  };
  await mockTvApi(context, identity);
  await installFakeEventSource(page);
  // O PC de mentira anuncia o toque na imagem no canal direto, como o agente com a tela ligada.
  await installFakeRtc(page, { caps: ['pc.tap.v1'] });
});

/** Abre a tela do PC com dois monitores e um quadro do principal (16:9, como o monitor). */
async function openPcScreen(page: Page): Promise<void> {
  await page.goto('/pc/tela');
  const openButton = page.getByRole('button', { name: 'Ver a tela' });
  await expect(openButton).toBeEnabled();
  await openButton.click();
  await injectRtcScreenMonitors(page, TWO_MONITORS);
  await injectRtcScreenFrame(page, 640, 360, 1);
  await expect(page.locator('canvas[aria-label="Tela do PC"]')).toBeVisible();
  await settle(page);
}

/** Os comandos que o PC de mentira recebeu pelo canal direto de entrada, de um tipo. */
async function commands(page: Page, type: string): Promise<Record<string, unknown>[]> {
  const log = await rtcLog(page);
  return (log?.input ?? [])
    .filter((message) => message['k'] === 'cmd' && message['t'] === type)
    .map((message) => (message['b'] ?? {}) as Record<string, unknown>);
}

/** O texto que chegou ao PC, pelo canal direto ou pela nuvem. */
async function typedText(page: Page): Promise<string> {
  const direct = (await commands(page, 'pc.text.v1')).map((body) => String(body['text']));
  const cloud = pc.sent('/text').map((body) => String(body['text']));
  return [...direct, ...cloud].join('');
}

const keyboardButton = (page: Page) => page.getByRole('button', { name: 'Teclado', exact: true });
const enterButton = (page: Page) => page.getByRole('button', { name: 'Tela cheia', exact: true });
const exitButton = (page: Page) => page.getByRole('button', { name: 'Sair da tela cheia' });

/** A moldura que vai para a tela cheia ocupa a janela inteira. */
async function expectCoversViewport(page: Page): Promise<void> {
  const size = page.viewportSize()!;
  await expect
    .poll(async () => {
      const box = await page.locator('.shell').boundingBox();
      return (
        box && [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]
      );
    })
    .toEqual([0, 0, size.width, size.height]);
}

test.describe('tela do PC: digitar e tela cheia', () => {
  test('o botão Teclado abre o teclado do aparelho e o texto vai ao PC na hora', async ({
    page,
  }) => {
    await openPcScreen(page);
    await keyboardButton(page).click();
    const field = page.getByLabel('Digitar no PC');
    await expect(field).toBeFocused();
    await expect(keyboardButton(page)).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.type('xqz7');
    await expect.poll(() => typedText(page)).toBe('xqz7');
    // O campo não mostra o que se digitou e a página não o repete.
    await expect(page.locator('app-pc-screen-page')).not.toContainText('xqz7');
    const stored = await page.evaluate(() =>
      [localStorage, sessionStorage].flatMap((area) =>
        Array.from({ length: area.length }, (_, index) => area.getItem(area.key(index)!) ?? ''),
      ),
    );
    expect(stored.some((value) => value.includes('xqz7'))).toBe(false);

    // Tocar de novo fecha o teclado.
    await keyboardButton(page).click();
    await expect(field).not.toBeFocused();
    await expect(keyboardButton(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('entra e sai da tela cheia sem reabrir a tela nem perder o monitor escolhido', async ({
    page,
  }) => {
    await openPcScreen(page);
    const monitor2 = page.getByRole('button', { name: 'Monitor 2' });
    await monitor2.click();
    await expect(monitor2).toHaveAttribute('aria-pressed', 'true');
    const offers = pc.sent('/rtc/offer').length;
    const connections = (await rtcLog(page))!.connections;

    await enterButton(page).click();
    await expect(exitButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expectCoversViewport(page);
    await expect(monitor2).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Parar' })).toBeVisible();

    await exitButton(page).click();
    await expect(enterButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(monitor2).toHaveAttribute('aria-pressed', 'true');
    expect(pc.sent('/rtc/offer').length).toBe(offers);
    expect((await rtcLog(page))!.connections).toBe(connections);
  });

  test('em tela cheia o toque no meio da imagem cai no meio da tela do PC', async ({ page }) => {
    await openPcScreen(page);
    await enterButton(page).click();
    await expectCoversViewport(page);
    await settle(page);

    const stage = page.locator('.stage');
    const box = (await stage.boundingBox())!;
    // O palco segue a proporção da imagem: sem faixas vazias que deslocariam o toque.
    expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.02);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(async () => (await commands(page, 'pc.tap.v1')).length).toBe(1);
    const [tap] = await commands(page, 'pc.tap.v1');
    expect(tap).toMatchObject({ m: 1, button: 'LEFT', action: 'CLICK' });
    expect(Math.abs(Number(tap['u']) - 32768)).toBeLessThan(700);
    expect(Math.abs(Number(tap['v']) - 32768)).toBeLessThan(700);
  });

  test('sem a Fullscreen API (como no iPhone) a tela cheia cobre a página pelo CSS', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      delete (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen;
      delete (Element.prototype as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen;
    });
    await openPcScreen(page);
    await enterButton(page).click();
    await expect(page.locator('.shell')).toHaveClass(/pseudo/);
    await expectCoversViewport(page);
    // A barra de abas do módulo fica por baixo.
    const covered = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Abas do módulo"]');
      if (!nav) return true;
      const rect = nav.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return !nav.contains(hit);
    });
    expect(covered).toBe(true);

    await page.keyboard.press('Escape');
    await expect(enterButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.shell')).not.toHaveClass(/pseudo/);
  });

  test('um navegador que aceita o pedido de tela cheia e não entra ainda mostra a imagem na janela toda', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Element.prototype, 'requestFullscreen', {
        value: () => undefined,
        configurable: true,
      });
    });
    await openPcScreen(page);
    await enterButton(page).click();
    await expect(exitButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expectCoversViewport(page);
    const canvas = (await page.locator('canvas[aria-label="Tela do PC"]').boundingBox())!;
    expect(canvas.width).toBeGreaterThan(100);
    expect(canvas.height).toBeGreaterThan(50);
    await exitButton(page).click();
    await expect(enterButton(page)).toHaveAttribute('aria-pressed', 'false');
  });
});
