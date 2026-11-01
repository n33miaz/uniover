import { IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, test } from '../fixtures';
import { mockSystemApi } from '../system/system-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

let identity: IdentityMock;

test.beforeEach(async ({ context }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
});

/**
 * O simulador atende `**\/health/version`, e esse padrão também casa `/api/health/version`: por isso o defeito (a tela
 * pedia a rota errada) passou despercebido. Aqui a rota errada responde 404, como o servidor de verdade, e a linha
 * só pode mostrar a versão se o pedido for exatamente `/health/version`.
 */
test('Sobre mostra a versão da API pedindo /health/version, e nunca por baixo de /api', async ({
  page,
}) => {
  const asked: string[] = [];
  await page.route('**/api/health/**', (route) => route.fulfill({ status: 404, body: '' }));
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.includes('health/version')) asked.push(pathname);
  });

  await page.goto('/ajustes/sobre');
  const row = page.locator('.ui-row', { hasText: 'Versão da API' });
  await expect(row).toContainText('0.5.0-teste');
  await expect(row).not.toContainText('indisponível agora');
  expect(asked).toEqual(['/health/version']);
});

test('Sistema lê a versão do servidor pela mesma rota', async ({ context, page }) => {
  await mockSystemApi(context, identity);
  const asked: string[] = [];
  await page.route('**/api/health/**', (route) => route.fulfill({ status: 404, body: '' }));
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.includes('health/version')) asked.push(pathname);
  });
  await page.goto('/ajustes/sistema');
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  expect(new Set(asked)).toEqual(new Set(['/health/version']));
});
