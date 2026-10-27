import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Só o e2e da atualização do app (e2e/update), sem construir nem servir nada: o próprio teste liga o servidor de
 * versões em cima de um build pronto. `UPDATE_E2E_DIST` aponta para outra pasta de build (por padrão, `dist/web/browser`),
 * o que permite rodar o teste contra um build antigo e provar o defeito.
 *
 *   npx playwright test -c playwright.update.config.ts
 */
export default defineConfig({
  ...base,
  testDir: './e2e/update',
  outputDir: './test-results-update',
  reporter: [['list']],
  webServer: undefined,
});
