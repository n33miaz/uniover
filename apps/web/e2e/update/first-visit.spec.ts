import { ChildProcess, spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Page } from '@playwright/test';
import { expect, test, waitForServiceWorkerControl } from '../fixtures';

/**
 * Primeira visita de um perfil novo: o worker ainda está instalando (aqui, devagar de propósito) e depois assume a
 * página. Ele é a versão atual, não uma "versão nova", então o aviso "Nova versão disponível" nunca pode aparecer.
 */
const DIST = resolve(process.env['UPDATE_E2E_DIST'] ?? 'dist/web/browser');
const INSTALL_DELAY_MS = 80;

let child: ChildProcess;
let origin = '';
let control = '';
let nextVersionDir = '';

async function setControl(path: string): Promise<void> {
  await fetch(`${control}${path}`);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  child = spawn(process.execPath, ['e2e/server/two-versions-server.mjs', DIST], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((done, fail) => {
    let buffer = '';
    child.on('error', fail);
    child.on('exit', (code) => fail(new Error(`servidor de versões saiu com ${code}`)));
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        const info = JSON.parse(line) as { port?: number; tmp?: string; control?: number };
        if (info.port) {
          origin = `http://localhost:${info.port}`;
          nextVersionDir = info.tmp!;
        }
        if (info.control) control = `http://localhost:${info.control}`;
      }
      if (origin && control) done();
    });
  });
});

test.afterAll(async () => {
  child?.removeAllListeners('exit');
  child?.kill();
  if (nextVersionDir) await rm(nextVersionDir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await setControl('/use?v=a');
  await setControl('/sw-delay?ms=0');
  await setControl('/api-delay?ms=0');
  await setControl('/me-delay?ms=0');
  await setControl('/owner?on=0');
  await setControl(`/install-delay?ms=${INSTALL_DELAY_MS}`);
});

test.afterEach(async () => {
  await setControl('/install-delay?ms=0');
});

const banner = (page: Page) =>
  page.getByRole('status').filter({ hasText: 'Nova versão disponível' });

const noController = (page: Page) =>
  page.evaluate(() => navigator.serviceWorker.controller === null);

test.describe('primeira visita com o worker ainda instalando', () => {
  test('o worker que instala e assume a página não acende o aviso de versão nova', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto(`${origin}/`);
    await expect(page.locator('article.card').first()).toBeVisible();
    // A página subiu antes de o worker assumir: é o caso da primeira visita.
    expect(await noController(page)).toBe(true);
    await expect(banner(page)).toHaveCount(0);
    await waitForServiceWorkerControl(page);
    // Quando o worker assume, dá tempo de qualquer aviso tardio aparecer.
    await page.waitForTimeout(2_000);
    await expect(banner(page)).toHaveCount(0);
  });

  test('navegar entre telas durante a instalação também não acende o aviso', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`${origin}/`);
    await expect(page.locator('article.card').first()).toBeVisible();
    expect(await noController(page)).toBe(true);
    // Outra abertura completa no mesmo perfil, ainda sem worker no comando.
    await page.goto(`${origin}/tv`);
    await expect(banner(page)).toHaveCount(0);
    await page.goto(`${origin}/`);
    await expect(page.locator('article.card').first()).toBeVisible();
    await waitForServiceWorkerControl(page);
    await page.waitForTimeout(2_000);
    await expect(banner(page)).toHaveCount(0);
  });

  test('a conta do dono, três telas abertas durante a instalação e a troca de worker', async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    await setControl('/owner?on=1');
    const pages = [page, await context.newPage(), await context.newPage()];
    const paths = ['/tv', '/tv/internet', '/pc'];
    for (const [index, path] of paths.entries()) await pages[index].goto(`${origin}${path}`);
    for (const open of pages) await expect(banner(open)).toHaveCount(0);
    await waitForServiceWorkerControl(page);
    await page.waitForTimeout(3_000);
    for (const open of pages) await expect(banner(open)).toHaveCount(0);
  });
});
