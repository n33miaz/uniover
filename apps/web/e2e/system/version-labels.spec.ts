import { Page } from '@playwright/test';
import { mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { settle } from '../screens/screen-helpers';
import { MockTv, installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { MockComputer, mockSystemApi } from './system-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const SHOTS = process.env['SMALL_SHOTS'] ?? 'test-results';

/** O que `GET /health/version` devolve em produção: a versão e a de cada módulo, shopping incluído. */
const MODULES = {
  identity: '0.45.1',
  devices: '0.61.0',
  tv: '0.50.1',
  training: '0.44.2',
  shopping: '0.3.1',
  web: '0.64.0',
  agent: '0.57.0',
};

let versionRequests: string[] = [];

const CASA: MockComputer = {
  slug: 'pc-casa',
  name: 'PC de casa',
  platform: 'windows',
  online: true,
  revoked: false,
};
const TV_CASA: MockTv = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Casa',
  isDefault: true,
  agentSlug: 'pc-casa',
  kind: 'android',
  online: true,
  capabilities: ['tv.remote', 'tv.kind.android', 'tv.adb'],
};

test.beforeEach(async ({ context, page }) => {
  const identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  const tv = await mockTvApi(context, identity);
  const system = await mockSystemApi(context, identity);
  tv.tvs = [{ ...TV_CASA }];
  system.computers.push({ ...CASA });
  system.current = CASA.slug;
  system.source = 'saved';
  versionRequests = [];
  await installFakeEventSource(page);
  // A rota real da API é `/health/version`, na raiz (não sob `/api`); registrada por último, esta resposta vence a do mock.
  await context.route('**/health/version', (route) => {
    versionRequests.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ commit: 'a'.repeat(40), version: '0.67.0', modules: MODULES }),
    });
  });
  // Qualquer outro caminho de versão sob `/api` responde 404, como em produção: usá-lo faria o teste falhar.
  await context.route('**/api/health/**', (route) => route.fulfill({ status: 404, body: '' }));
});

async function openSystem(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/ajustes/sistema');
  await expect(page.getByRole('heading', { level: 1, name: 'Sistema' })).toBeVisible();
  await expect(page.locator('.modules-list li').first()).toBeVisible();
}

test.describe('Configurações > Sobre e Sistema: rótulos de versão', () => {
  test('Sobre mostra a versão do serviço lida de /health/version', async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/ajustes/sobre');
    await expect(page.getByRole('heading', { level: 1, name: 'Sobre' })).toBeVisible();
    await expect(page.getByText('indisponível agora')).toHaveCount(0);
    await expect(page.locator('.facts dd').nth(1)).toHaveText('0.67.0');
    await expect(page.locator('.ui-skeleton')).toHaveCount(0);
    expect(versionRequests).toContain('/health/version');
    await settle(page);
    await expectNoHorizontalScroll(page);
    await screenshot(page, `${SHOTS}/sobre-${info.project.name}.png`, { fullPage: true });
  });

  test('Sistema lista os módulos traduzidos e a versão nunca quebra em duas linhas', async ({
    page,
  }, info) => {
    await openSystem(page);
    const labels = await page.locator('.modules-list li > span:first-child').allTextContents();
    expect(labels.map((label) => label.trim())).toEqual([
      'Identidade',
      'Dispositivos',
      'TV',
      'Treino',
      'Compras',
      'Site',
      'Programa do computador',
    ]);
    await expect(page.locator('.modules-list')).not.toContainText('shopping');

    // Em 390 px (o projeto) e em 360 px: cada versão cabe numa linha só e a lista não estoura a largura.
    for (const width of [page.viewportSize()?.width ?? 390, 360]) {
      await page.setViewportSize({ width, height: 664 });
      await settle(page);
      for (const version of await page.locator('.module-version').all()) {
        const lineHeight = await version.evaluate((el) =>
          parseFloat(getComputedStyle(el).lineHeight),
        );
        const box = await version.boundingBox();
        expect(box, `versão visível em ${width} px`).not.toBeNull();
        expect(box!.height, `${await version.textContent()} em ${width} px`).toBeLessThanOrEqual(
          lineHeight * 1.2,
        );
      }
      await expectNoHorizontalScroll(page);
    }

    await page.setViewportSize({ width: 390, height: 664 });
    await page.locator('.modules').scrollIntoViewIfNeeded();
    await screenshot(page, `${SHOTS}/sistema-${info.project.name}.png`, { fullPage: true });
  });
});
