import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';
import { IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { settle } from '../screens/screen-helpers';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { PcMock, mockPcApi } from './pc-mock';
import {
  injectRtcScreenFrame,
  injectRtcScreenMonitors,
  installFakeRtc,
} from './rtc-fake';

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

      // Tab avança para o botão Parar.
      await page.keyboard.press('Tab');
      await expect(stop).toBeFocused();

      // Garante novamente a ausência de rolagem horizontal após interações por teclado.
      await expectNoHorizontalScroll(page);
    });
  }
});
