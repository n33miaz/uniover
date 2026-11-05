import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

const PORT = Number(process.env['E2E_PORT'] ?? 4410);

/**
 * O catálogo de telas (`npm run catalog`): visita todas as rotas do app com a API simulada do e2e e junta as capturas
 * num HTML só. Fica fora da execução normal (o `playwright.config.ts` ignora `e2e/catalog`); quem o roda é este arquivo.
 *
 * Um aparelho só (iPhone 12 no Safari, 390 x 664 úteis, WebKit), um trabalhador, e o dobro de pixels em vez do triplo para
 * o HTML caber em poucos MB. `CATALOG_SKIP_BUILD=1` serve o `dist` que já existe, sem construir de novo.
 */
export default defineConfig({
  ...base,
  testDir: './e2e/catalog',
  testIgnore: [],
  outputDir: './test-results-catalog/playwright',
  reporter: [['list']],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 15 * 60_000,
  globalSetup: './e2e/catalog/global-setup.ts',
  globalTeardown: './e2e/catalog/global-teardown.ts',
  use: { baseURL: `http://localhost:${PORT}`, actionTimeout: 15_000, navigationTimeout: 30_000 },
  webServer: {
    command: `${process.env['CATALOG_SKIP_BUILD'] ? '' : 'npm run build && '}node e2e/server/static-server.mjs ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 300_000,
  },
  projects: [
    {
      name: 'catalogo-iphone-12',
      use: {
        ...devices['iPhone 12'],
        viewport: { width: 390, height: 664 },
        deviceScaleFactor: 2,
        browserName: 'webkit',
      },
    },
  ],
});
