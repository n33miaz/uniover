import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';
import { GUEST, IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
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

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Abas do módulo' });

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
  await installFakeRtc(page);
});

function criticalViolations(
  violations: Array<{ id: string; impact?: string | null; nodes: Array<{ target: unknown[] }> }>,
) {
  return violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

/** Abre a rota /pc/tela, conecta a tela e injeta os monitores e o quadro simulado. */
async function openPcScreen(page: Page): Promise<void> {
  await page.goto('/pc/tela');
  await expect(page.getByRole('heading', { level: 1, name: 'Controle do PC' })).toBeVisible();

  const openButton = page.getByRole('button', { name: 'Ver a tela' });
  await expect(openButton).toBeEnabled();
  await openButton.click();

  await injectRtcScreenMonitors(page, TWO_MONITORS);
  await injectRtcScreenFrame(page, 640, 360, 1);

  await expect(page.locator('canvas[aria-label="Tela do PC"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Monitor 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Monitor 2' })).toBeVisible();
  await settle(page);
}

test.describe('tela do PC (/pc/tela)', () => {
  test('abre na primeira aba para o dono e mantém as demais telas acessíveis', async ({ page }) => {
    await page.goto('/pc', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/pc\/tela$/);
    await expect(tabs(page).getByRole('link')).toHaveText([
      'Tela',
      'Mouse',
      'Atalhos',
      'Mídia',
      'Mais',
    ]);
    await expect(tabs(page).locator('[aria-current="page"]')).toHaveText('Tela');
    await expect(page.getByRole('button', { name: 'Ver a tela' })).toBeVisible();

    await tabs(page).getByRole('link', { name: 'Mouse' }).click();
    await expect(page).toHaveURL(/\/pc\/mouse$/);
    await expect(page.locator('app-pc-mouse-page')).toBeVisible();
    await expect(tabs(page).locator('[aria-current="page"]')).toHaveText('Mouse');

    await page.goBack();
    await expect(page).toHaveURL(/\/pc\/tela$/);
    await expect(tabs(page).locator('[aria-current="page"]')).toHaveText('Tela');

    const directLinks = [
      ['/pc/mouse', 'Mouse'],
      ['/pc/atalhos', 'Atalhos'],
      ['/pc/midia', 'Mídia'],
      ['/pc/mais', 'Mais'],
      ['/pc/energia', 'Mais'],
      ['/pc/area-de-transferencia', 'Mais'],
      ['/pc/controles', 'Mais'],
    ];
    for (const [path, tab] of directLinks) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL((url) => url.pathname === path);
      await expect(tabs(page).locator('[aria-current="page"]')).toHaveText(tab);
    }

    await page.goto('/pc/teclado', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/pc\/?\?teclado=1$/);
    await expect(page.locator('app-pc-mouse-page')).toBeVisible();
    await expect(page.locator('app-tab-bar [aria-current="page"]')).toHaveText('Mouse');
  });

  test('mantém o Mouse como entrada para quem tem acesso ao PC sem acesso à tela', async ({
    page,
  }) => {
    identity.role = 'guest';
    identity.guests.push({
      ...GUEST,
      id: '00000000-0000-4000-8000-000000000051',
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:pc'],
    });

    for (const path of ['/pc', '/pc/tela']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/\/pc\/?$/);
      await expect(page.locator('app-pc-mouse-page')).toBeVisible();
      await expect(tabs(page).getByRole('link')).toHaveText(['Mouse', 'Atalhos', 'Mídia', 'Mais']);
      await expect(tabs(page).locator('[aria-current="page"]')).toHaveAttribute(
        'href',
        /^\/pc\/?$/,
      );
    }
    expect(pc.sent('/rtc/offer').some((body) => body['parentSessionId'])).toBe(false);
  });

  test('mantém o Mouse como entrada quando o PC não oferece visualização', async ({ page }) => {
    pc.status = { ...pc.status, capabilities: ['pc.rtc.v1'] };
    await page.goto('/pc', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/pc\/?$/);
    await expect(page.locator('app-pc-mouse-page')).toBeVisible();
    await expect(tabs(page).getByRole('link')).toHaveText(['Mouse', 'Atalhos', 'Mídia', 'Mais']);
  });

  test('exibe a imagem sem os controles de toque quando o PC só oferece visualização', async ({
    page,
  }) => {
    pc.status = { ...pc.status, capabilities: ['pc.rtc.v1', 'pc.screen.v1'] };
    await openPcScreen(page);
    await expect(tabs(page).locator('[aria-current="page"]')).toHaveText('Tela');
    await expect(page.getByRole('group', { name: 'Toque na tela' })).toHaveCount(0);
  });

  test('a aba Tela continua aguardando o canal direto quando o dispositivo não foi aprovado', async ({
    page,
  }) => {
    pc.rtcOfferFailure = { status: 403, kind: 'device-pending' };
    await page.goto('/pc');
    await expect(page).toHaveURL(/\/pc\/tela$/);
    await expect.poll(() => pc.sent('/rtc/offer').length).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Ver a tela' })).toBeDisabled();
    expect(pc.sent('/rtc/offer').some((body) => body['parentSessionId'])).toBe(false);
  });

  test('abre a rota, injeta dois monitores e um quadro e exibe os controles', async ({ page }) => {
    await openPcScreen(page);

    const monitor1 = page.getByRole('button', { name: 'Monitor 1' });
    const monitor2 = page.getByRole('button', { name: 'Monitor 2' });
    const directTouch = page.getByRole('button', { name: 'Toque direto' });
    const scroll = page.getByRole('button', { name: 'Rolar' });
    const stop = page.getByRole('button', { name: 'Parar' });

    // Monitor primário vem selecionado por padrão.
    await expect(monitor1).toHaveAttribute('aria-pressed', 'true');
    await expect(monitor2).toHaveAttribute('aria-pressed', 'false');
    await expect(directTouch).toBeVisible();
    await expect(scroll).toBeVisible();
    await expect(stop).toBeVisible();

    // Seleciona o segundo monitor.
    await monitor2.click();
    await expect(monitor1).toHaveAttribute('aria-pressed', 'false');
    await expect(monitor2).toHaveAttribute('aria-pressed', 'true');

    // Ao parar, a transmissão encerra e volta ao botão de ver tela.
    await stop.click();
    await expect(page.getByRole('button', { name: 'Ver a tela' })).toBeVisible();
  });

  const viewports = [
    { name: '390x664 (celular compacto)', width: 390, height: 664 },
    { name: '411x800 (celular padrão)', width: 411, height: 800 },
  ];

  for (const vp of viewports) {
    test(`acessibilidade (axe sem violações críticas) no viewport ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openPcScreen(page);

      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(criticalViolations(violations)).toEqual([]);
    });

    test(`navegabilidade por teclado e ausência de rolagem horizontal no viewport ${vp.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openPcScreen(page);

      // Não deve apresentar rolagem horizontal com a tela ativa.
      await expectNoHorizontalScroll(page);

      const monitor1 = page.getByRole('button', { name: 'Monitor 1' });
      const monitor2 = page.getByRole('button', { name: 'Monitor 2' });
      const directTouch = page.getByRole('button', { name: 'Toque direto' });
      const scroll = page.getByRole('button', { name: 'Rolar' });
      const stop = page.getByRole('button', { name: 'Parar' });

      // Inicia navegação por teclado nos botões de monitor.
      await monitor1.focus();
      await expect(monitor1).toBeFocused();

      // Tab avança para o Monitor 2.
      await page.keyboard.press('Tab');
      await expect(monitor2).toBeFocused();

      // Enter seleciona o Monitor 2 via teclado.
      await page.keyboard.press('Enter');
      await expect(monitor2).toHaveAttribute('aria-pressed', 'true');
      await expect(monitor1).toHaveAttribute('aria-pressed', 'false');

      // Tab avança para a ferramenta de toque.
      await page.keyboard.press('Tab');
      await expect(directTouch).toBeFocused();

      // Tab avança para o botão de rolar.
      await page.keyboard.press('Tab');
      await expect(scroll).toBeFocused();

      // Tab avança para o teclado e para a tela cheia.
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Teclado', exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Tela cheia', exact: true })).toBeFocused();

      // Tab avança para o botão Parar.
      await page.keyboard.press('Tab');
      await expect(stop).toBeFocused();

      // Garante novamente a ausência de rolagem horizontal após interações por teclado.
      await expectNoHorizontalScroll(page);
    });
  }
});
