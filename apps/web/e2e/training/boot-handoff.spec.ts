import { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { startTraining } from './support/training-pages';

/**
 * Uma amostra do documento a cada quadro desde o primeiro script da página: diz se havia algo desenhado na tela (o
 * esqueleto estático do `index.html`, o do Angular, o da tela ou o conteúdo) e o que era.
 */
interface Sample {
  t: number;
  /** Algum esqueleto de abertura (`.bs-root`) visível: não oculto, com tamanho e opaco. */
  cover: boolean;
  /** Algum osso de esqueleto (`.bone`, `.ui-skeleton`) visível fora dos esqueletos de abertura. */
  bones: boolean;
  /** Texto visível da tela fora dos esqueletos de abertura. */
  text: number;
}

const sampler = (): void => {
  const out: Sample[] = [];
  (window as unknown as { __samples: Sample[] }).__samples = out;
  const shown = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    for (let node: Element | null = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
        return false;
    }
    return true;
  };
  const snap = (): void => {
    const body = document.body;
    if (!body) return;
    const covers = [...document.querySelectorAll('.bs-root')];
    const cover = covers.some(shown);
    const bones = [...document.querySelectorAll('app-root .bone, app-root .ui-skeleton')].some(
      (el) => !el.closest('.bs-root') && shown(el),
    );
    const root = document.querySelector('app-root');
    let text = 0;
    if (root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        const value = (node.textContent ?? '').trim();
        if (!parent || !value || parent.closest('.bs-root') || !shown(parent)) continue;
        text += value.length;
      }
    }
    out.push({ t: Math.round(performance.now()), cover, bones, text });
  };
  const loop = (): void => {
    snap();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  setInterval(snap, 25);
};

async function samplesOf(page: Page): Promise<Sample[]> {
  return page.evaluate(() => (window as unknown as { __samples: Sample[] }).__samples);
}

/** Os intervalos seguidos sem esqueleto de abertura, sem osso de esqueleto e sem texto: a tela estava em branco. */
function blankStretches(samples: Sample[]): { from: number; to: number }[] {
  const stretches: { from: number; to: number }[] = [];
  let from: number | null = null;
  for (const sample of samples) {
    const blank = !sample.cover && !sample.bones && sample.text === 0;
    if (blank && from === null) from = sample.t;
    if (!blank && from !== null) {
      stretches.push({ from, to: sample.t });
      from = null;
    }
  }
  return stretches;
}

/**
 * Quanto cada pedaço de código (a casca e a rota preguiçosas) demora a chegar. Com 0 a abertura é rápida; com a espera
 * o Angular sobe tarde e o esqueleto dele (que cobre o estático depois de `SLOW_BOOT_MS`) fica na tela por mais de um
 * segundo: é a janela em que uma sondagem que só olha o primeiro `.bs-root` e o `main` enxerga "tela em branco".
 */
const CHUNK_DELAYS_MS = [0, 300];

test.describe('troca do esqueleto de abertura pelo da tela', () => {
  // A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
  test.use({ serviceWorkers: 'block' });

  for (const delay of CHUNK_DELAYS_MS) {
    for (const path of ['/treino/rotinas', '/treino/corpo', '/treino/progresso']) {
      test(`${path} com pedaços atrasados em ${delay} ms: nenhum quadro em branco`, async ({
        page,
        context,
      }, testInfo) => {
        await startTraining(context, page);
        if (delay > 0) {
          await context.route(/\/(chunk|main|polyfills)-[^/]+\.js$/, async (route) => {
            await new Promise((resolve) => setTimeout(resolve, delay));
            await route.fallback();
          });
        }
        // Só a próxima carga é amostrada: a entrada acima já usou o documento.
        await page.addInitScript(sampler);
        await page.goto(path, { waitUntil: 'commit' });
        await expect(page.locator('main')).toContainText(/\S{3}/, { timeout: 25_000 });
        await page.waitForTimeout(1500);

        const samples = await samplesOf(page);
        expect(samples.length, 'a sondagem rodou').toBeGreaterThan(40);
        expect(samples[0].cover, 'o primeiro quadro já tem o esqueleto de abertura').toBe(true);
        const blanks = blankStretches(samples);
        await testInfo.attach('amostras', {
          body: JSON.stringify({ blanks, first: samples.slice(0, 5), n: samples.length }),
          contentType: 'application/json',
        });
        expect(blanks, 'intervalos sem nada desenhado (ms desde o início da página)').toEqual([]);
      });
    }
  }
});
