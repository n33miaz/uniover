import { ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Page } from '@playwright/test';
import { expect, test, waitForServiceWorkerControl } from '../fixtures';

/**
 * Primeira visita de um perfil novo: o worker ainda está instalando e depois assume a
 * página. Ele é a versão atual, não uma "versão nova", então o aviso "Nova versão disponível" nunca pode aparecer.
 */
const DIST = resolve(process.env['UPDATE_E2E_DIST'] ?? 'dist/web/browser');

let child: ChildProcess;
let origin = '';
let control = '';

async function setControl(path: string): Promise<void> {
  const response = await fetch(`${control}${path}`);
  expect(response.ok).toBe(true);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  child = spawn(process.execPath, ['e2e/server/two-versions-server.mjs', DIST, '--first-visit'], {
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
        const info = JSON.parse(line) as { port?: number; control?: number };
        if (info.port) origin = `http://localhost:${info.port}`;
        if (info.control) control = `http://localhost:${info.control}`;
      }
      if (origin && control) done();
    });
  });
});

test.afterAll(() => {
  child?.removeAllListeners('exit');
  child?.kill();
});

test.beforeEach(async () => {
  await setControl('/owner?on=0');
  await setControl('/hold-install?on=1');
});

test.afterEach(async () => {
  await setControl('/hold-install?on=0');
});

const banner = (page: Page) =>
  page.getByRole('status').filter({ hasText: 'Nova versão disponível' });

const noController = (page: Page) =>
  page.evaluate(() => navigator.serviceWorker.controller === null);

async function waitForInstalling(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return registration?.installing?.state;
        }),
      { timeout: 30_000 },
    )
    .toBe('installing');
}

async function lifecycleSettled(page: Page, mayStayUncontrolled = false): Promise<void> {
  if (!mayStayUncontrolled) await waitForServiceWorkerControl(page);
  await expect
    .poll(
      () =>
        page.evaluate(async (uncontrolledOk) => {
          const registration = await navigator.serviceWorker.getRegistration();
          const controller = navigator.serviceWorker.controller;
          return {
            active: registration?.active?.state,
            installing: !!registration?.installing,
            waiting: !!registration?.waiting,
            current: controller === registration?.active || (controller === null && uncontrolledOk),
          };
        }, mayStayUncontrolled),
      { timeout: 30_000 },
    )
    .toEqual({ active: 'activated', installing: false, waiting: false, current: true });
}

async function expectNoBanner(page: Page): Promise<void> {
  await page.bringToFront();
  // A instalação já foi liberada e o worker ativo assumiu a aba que o registrou. Em primeiro plano,
  // dois quadros dão ao Angular oportunidade de pintar o aviso antes da checagem pontual do DOM.
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await expect(banner(page)).toHaveCount(0);
}

test.describe('primeira visita com o worker ainda instalando', () => {
  test('o worker que instala e assume a página não acende o aviso de versão nova', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto(`${origin}/`);
    await expect(page.locator('article.card').first()).toBeVisible();
    // A página subiu antes de o worker assumir: é o caso da primeira visita.
    await waitForInstalling(page);
    expect(await noController(page)).toBe(true);
    await expect(banner(page)).toHaveCount(0);
    await setControl('/hold-install?on=0');
    await lifecycleSettled(page);
    await expectNoBanner(page);
  });

  test('navegar entre telas durante a instalação também não acende o aviso', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`${origin}/`);
    await expect(page.locator('article.card').first()).toBeVisible();
    await waitForInstalling(page);
    expect(await noController(page)).toBe(true);
    // Outra abertura completa no mesmo perfil, ainda sem worker no comando.
    await page.goto(`${origin}/tv`);
    await expect(page.locator('[data-screen-ready]').first()).toBeAttached();
    expect(await noController(page)).toBe(true);
    await expect(banner(page)).toHaveCount(0);
    await page.goto(`${origin}/`);
    await expect(page.locator('article.card').first()).toBeVisible();
    expect(await noController(page)).toBe(true);
    await setControl('/hold-install?on=0');
    await lifecycleSettled(page);
    await expectNoBanner(page);
  });

  test('a conta do dono, três telas abertas durante a instalação e a troca de worker', async ({
    page,
    context,
    browserName,
  }) => {
    test.setTimeout(120_000);
    await setControl('/owner?on=1');
    const pages = [page, await context.newPage(), await context.newPage()];
    const screens = [
      ['/tv', 'tv'],
      ['/tv/internet', 'tv-offline-guide'],
      ['/pc', 'pc'],
    ];
    for (const [index, [path, screen]] of screens.entries()) {
      const open = pages[index];
      await open.goto(`${origin}${path}`);
      await expect(open.locator(`[data-screen-ready="${screen}"]`)).toBeAttached();
      if (index === 0) await waitForInstalling(open);
      expect(await noController(open)).toBe(true);
      await expect(banner(open)).toHaveCount(0);
    }

    await setControl('/hold-install?on=0');
    await page.bringToFront();
    await lifecycleSettled(page);
    const scriptURL = new URL('/sw.js', origin).href;
    for (const open of pages.slice(1)) {
      await open.bringToFront();
      if (browserName === 'webkit') {
        // O WebKit pode deixar as abas auxiliares sem controlador nem registro local após clients.claim().
        // A aba principal já comprovou a ativação. Confere também o ciclo nas auxiliares que expõem o registro.
        const { controller, lifecycle } = await open.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return {
            controller: navigator.serviceWorker.controller?.scriptURL,
            lifecycle: registration && {
              active: registration.active?.state,
              installing: !!registration.installing,
              waiting: !!registration.waiting,
            },
          };
        });
        if (controller) expect(controller).toBe(scriptURL);
        if (lifecycle) {
          expect(lifecycle).toEqual({ active: 'activated', installing: false, waiting: false });
        }
      } else {
        await lifecycleSettled(open, true);
      }
    }
    for (const open of pages) await expectNoBanner(open);
  });
});
