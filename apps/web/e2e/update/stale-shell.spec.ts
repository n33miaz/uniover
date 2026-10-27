import { ChildProcess, spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Page } from '@playwright/test';
import { expect, screenshot, test, waitForServiceWorkerControl } from '../fixtures';

/**
 * Reproduz o defeito do botão "Atualizar": a página ficava só com o fundo e a pessoa precisava recarregar à mão.
 *
 * Como: um servidor próprio serve o build como versão `a`; no meio do teste passa a servir a versão `b`, uma cópia com
 * outro hash em todos os arquivos (um deploy), com nenhum nome da versão antiga. A versão `b` obedece ao pedido de
 * troca com atraso (um aparelho lento) e a API demora a responder, que é o que faz a casca recarregada pedir o pedaço
 * da tela (a rota da Início) depois de o worker novo já ter apagado o cache da versão antiga. Antes do conserto o
 * recarregamento por prazo fixo (1,5 s) subia a casca antiga e a tela ficava vazia; o teste falha nesse caso.
 *
 * O build servido como `a` é `dist/web/browser` (o que o `npm run build` gerou) ou o de `UPDATE_E2E_DIST`. Com
 * `UPDATE_E2E_LEGACY=1` o teste não exige o esqueleto: serve para rodar contra um build anterior ao conserto e ver a
 * falha original (a Início nunca aparece depois do toque).
 */
const DIST = resolve(process.env['UPDATE_E2E_DIST'] ?? 'dist/web/browser');
const LEGACY = process.env['UPDATE_E2E_LEGACY'] === '1';
const SW_DELAY_MS = 2_800;
// `UPDATE_E2E_API_DELAY_MS` alonga a espera da API (e, com ela, o momento em que a casca recarregada pede o pedaço da tela).
const API_DELAY_MS = Number(process.env['UPDATE_E2E_API_DELAY_MS'] ?? 2_000);

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

/**
 * O que a página viu de errado (pedaços de código que o servidor negou, erros de console e de página): anexado a cada
 * teste e impresso quando ele falha, para o relatório citar a causa e não só "não apareceu".
 */
let diagnostics: string[] = [];
let startedAt = 0;
const TRACE = process.env['UPDATE_E2E_TRACE'] === '1';

test.beforeEach(async ({ page }) => {
  diagnostics = [];
  startedAt = Date.now();
  page.on('response', (response) => {
    const chunk = /\/chunk-[\w-]+\.js$/.test(response.url());
    if (chunk && (response.status() >= 400 || TRACE))
      diagnostics.push(
        `${Date.now() - startedAt} ms ${response.status()} ${response.fromServiceWorker() ? 'sw' : 'rede'} ${response.url()}`,
      );
  });
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
  await setControl('/use?v=a');
  await setControl('/sw-delay?ms=0');
  await setControl('/api-delay?ms=0');
});

test.afterEach(async ({}, info) => {
  await info.attach('diagnostico', { body: diagnostics.join('\n') || '(nada)' });
  if (info.status !== info.expectedStatus)
    console.log(`[diagnostico] ${info.title}\n${diagnostics.join('\n')}`);
});

const banner = (page: Page) =>
  page.getByRole('status').filter({ hasText: 'Nova versão disponível' });
const homeCards = (page: Page) => page.locator('article.card');
const skeleton = (page: Page) => page.locator('app-update-skeleton .overlay');
const mainScript = (page: Page) =>
  page.evaluate(() => document.querySelector('script[src^="main-"]')?.getAttribute('src') ?? '');

/** Abre a versão `a` já com o worker no controle e a Início na tela. */
async function openVersionA(page: Page): Promise<string> {
  await page.goto(`${origin}/`);
  await waitForServiceWorkerControl(page);
  await expect(homeCards(page).first()).toBeVisible();
  return mainScript(page);
}

test.describe('atualização com a casca antiga já aberta', () => {
  test('o toque em Atualizar cobre a tela com o esqueleto e termina na versão nova com a Início', async ({
    page,
    context,
  }, info) => {
    // Guarda se o esqueleto chegou a existir em cada documento (a recarga recomeça tudo; o script roda de novo).
    await context.addInitScript(() => {
      (window as unknown as { __skeletonSeen: boolean }).__skeletonSeen = false;
      new MutationObserver(() => {
        if (document.querySelector('app-update-skeleton .overlay'))
          (window as unknown as { __skeletonSeen: boolean }).__skeletonSeen = true;
      }).observe(document, { childList: true, subtree: true });
    });
    const before = await openVersionA(page);

    // O "deploy": a versão b passa a ser servida, lenta para ativar, e a API fica lenta.
    await setControl('/use?v=b');
    await setControl(`/sw-delay?ms=${SW_DELAY_MS}`);
    await setControl(`/api-delay?ms=${API_DELAY_MS}`);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });
    await expect(banner(page)).toBeVisible();

    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await banner(page).getByRole('button', { name: 'Atualizar' }).click();
    // Logo no toque, o esqueleto de página inteira cobre tudo (não o "Atualizando…" quase invisível).
    if (!LEGACY) {
      await expect(skeleton(page)).toBeVisible({ timeout: 1_000 });
      if (info.project.name === 'iphone-12')
        await screenshot(page, 'test-results/update-skeleton-iphone-12.png');
    }

    await expect
      .poll(() => page.evaluate(() => performance.timeOrigin).catch(() => timeOrigin), {
        message: 'a página recarregou',
        timeout: 20_000,
      })
      .not.toBe(timeOrigin);
    // A página nova nasce já com o esqueleto e o mantém até o primeiro conteúdo: nada de fundo vazio.
    await expect(homeCards(page).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Bom dia|Boa tarde|Boa noite/);
    if (!LEGACY) {
      await expect(skeleton(page)).toHaveCount(0);
      expect(
        await page.evaluate(() => (window as never as { __skeletonSeen: boolean }).__skeletonSeen),
      ).toBe(true);
    }
    expect(await mainScript(page)).not.toBe(before);
    await expect(banner(page)).toHaveCount(0);
  });

  test('um pedaço de tela que sumiu no deploy faz o app se atualizar sozinho, uma vez', async ({
    page,
  }) => {
    const before = await openVersionA(page);

    // O deploy chega e o worker novo assume (como se outra aba tivesse tocado em Atualizar): o cache da versão
    // antiga some, e esta aba ainda roda a casca antiga.
    await setControl('/use?v=b');
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
      const worker = registration?.waiting ?? registration?.installing;
      if (!worker) throw new Error('sem worker novo');
      await new Promise<void>((done) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => done(), { once: true });
        const post = () => worker.postMessage({ type: 'SKIP_WAITING' });
        if (worker.state === 'installed') post();
        else
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed') post();
          });
      });
    });
    expect(await mainScript(page)).toBe(before);

    // Navegar para uma tela cujo pedaço de código ainda não foi baixado: a rota falha (404) e o app reage.
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await page.evaluate(() => {
      history.pushState({}, '', '/conectar');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect
      .poll(() => page.evaluate(() => performance.timeOrigin).catch(() => timeOrigin), {
        message: 'a página se recarregou sozinha',
        timeout: 20_000,
      })
      .not.toBe(timeOrigin);
    await expect(page.getByRole('heading', { level: 1, name: 'Conectar este PC' })).toBeVisible({
      timeout: 20_000,
    });
    expect(await mainScript(page)).not.toBe(before);
    // Uma única recarga: a guarda ficou marcada e a página nova não recarregou de novo.
    expect(
      await page.evaluate(() => sessionStorage.getItem('uniover.update.chunk-recovery')),
    ).not.toBeNull();
  });
});
