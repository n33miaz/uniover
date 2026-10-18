import { defineConfig, devices } from '@playwright/test';

const PORT = 4300;

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: `http://localhost:${PORT}` },
  // Serve o build de produção (o mesmo que a imagem Docker copia para o wwwroot).
  webServer: {
    command: `npx ng build && node e2e/static-server.mjs ${PORT}`,
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
