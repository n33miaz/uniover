import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['E2E_PORT'] ?? 4300);

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  reporter: [['list'], ['html', { open: 'never' }]],
  // Na CI uma segunda tentativa absorve o tropeço de tempo do executor (o teste que só passa na segunda vira "flaky" no
  // relatório, não some). Refazer a esteira inteira por um teste custava mais de 10 minutos.
  retries: process.env['CI'] ? 1 : 0,
  use: { baseURL: `http://localhost:${PORT}`, trace: 'on-first-retry' },
  // Serve o build de produção (o mesmo que a imagem Docker copia para o wwwroot).
  webServer: {
    command: `npm run build && node e2e/server/static-server.mjs ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
  },
  projects: [
    {
      name: 'iphone-12',
      use: {
        ...devices['iPhone 12'],
        viewport: { width: 390, height: 664 },
        browserName: 'webkit',
      },
    },
    {
      name: 's23-fe',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 411, height: 800 },
        browserName: 'chromium',
      },
    },
  ],
});
