import { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { startTraining } from './support/training-pages';

/**
 * Uma amostra do documento depois de uma pintura (ou de uma mudança do DOM) desde o primeiro script da página: diz se
 * havia algo desenhado na área da tela roteada ou por cima dela (o esqueleto estático do `index.html`, o do Angular, o da
 * própria tela ou o conteúdo).
 */
interface Sample {
  t: number;
  /** De onde veio a amostra: depois de uma pintura (`frame`) ou logo após uma mudança do DOM (`mutation`). */
  src: 'frame' | 'mutation';
  /** Algum esqueleto de abertura (`.bs-root`) com um `.bone` visível e opacidade efetiva acima de 0,5. */
  cover: boolean;
  /** O esqueleto do Angular (`app-update-skeleton .bs-root`) existe no documento. */
  angular: boolean;
  /** A folha de estilos principal ainda não chegou (`data-styles="pending"`). */
  stylesPending: boolean;
  /** A casca do Treino já marcou `data-screen-ready`: o esqueleto estático pode sair a qualquer momento. */
  marker: boolean;
  /** Algum osso de esqueleto visível dentro da tela roteada (não conta a barra de topo nem a navegação da casca). */
  bones: boolean;
  /** Texto visível dentro da tela roteada (sem o texto só para leitor de tela). */
  text: boolean;
}

interface Probe {
  samples: Sample[];
  /** Quantas vezes o laço de `requestAnimationFrame` rodou. */
  frames: number;
}

/** Roda na página, antes de qualquer script dela. Autocontido: o Playwright o serializa. */
const sampler = (): void => {
  const probe: Probe = { samples: [], frames: 0 };
  (window as unknown as { __boot: Probe }).__boot = probe;
  /** O esqueleto de abertura só vale como cobertura enquanto ainda se vê (o fim da saída é quase transparente). */
  const COVER_OPACITY = 0.5;
  /** O conteúdo da tela só precisa ser perceptível: o brilho e a entrada dele começam de opacidade baixa. */
  const PAGE_OPACITY = 0.1;
  /** Só olha o que é barato de ler: a caixa primeiro, depois a visibilidade e a opacidade acumulada dos ancestrais. */
  const seen = (el: Element, minOpacity: number): boolean => {
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return false;
    if (box.bottom <= 0 || box.right <= 0 || box.top >= innerHeight || box.left >= innerWidth)
      return false;
    if (getComputedStyle(el).visibility === 'hidden') return false;
    let opacity = 1;
    for (let node: Element | null = el; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
      if (opacity <= minOpacity) return false;
    }
    return true;
  };
  const anyBone = (root: Element, minOpacity: number): boolean => {
    for (const bone of root.querySelectorAll('.bone, .ui-skeleton')) {
      if (seen(bone, minOpacity)) return true;
    }
    return false;
  };
  const anyText = (root: Element, minOpacity: number): boolean => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !(node.textContent ?? '').trim() || parent.closest('.ui-visually-hidden'))
        continue;
      if (seen(parent, minOpacity)) return true;
    }
    return false;
  };
  let armed = false;
  const snap = (src: Sample['src']): void => {
    if (!document.body || probe.samples.length > 20_000) return;
    const cover = [...document.querySelectorAll('.bs-root')].some((root) => {
      for (const bone of root.querySelectorAll('.bone')) {
        if (seen(bone, COVER_OPACITY)) return true;
      }
      return false;
    });
    // A área da tela roteada é o irmão do `<router-outlet>` da casca do Treino: a barra de topo e a navegação da casca
    // ficam fora dela, e por isso não escondem um vazio onde a tela deveria estar.
    const page = document.querySelector('app-training-page router-outlet + *');
    const bones = page ? anyBone(page, PAGE_OPACITY) : false;
    const text = page ? anyText(page, PAGE_OPACITY) : false;
    // O parser pode inserir o `<body>` antes do esqueleto estático: só vale como "em branco" depois do primeiro desenho.
    if (cover || bones || text) armed = true;
    else if (src === 'mutation' && !armed) return;
    probe.samples.push({
      t: Math.round(performance.now()),
      src,
      cover,
      angular: !!document.querySelector('app-update-skeleton .bs-root .bone'),
      stylesPending: document.documentElement.getAttribute('data-styles') === 'pending',
      marker: !!document.querySelector('[data-screen-ready="training"]'),
      bones,
      text,
    });
  };
  // Depois da pintura: o `postMessage` feito de dentro do rAF vira uma tarefa que roda depois do quadro desenhado.
  const channel = new MessageChannel();
  channel.port1.onmessage = () => snap('frame');
  const loop = (): void => {
    probe.frames++;
    channel.port2.postMessage(null);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  // E em cada mudança do DOM: pega o estado entre dois quadros que o laço, sozinho, não enxerga.
  new MutationObserver(() => snap('mutation')).observe(document, {
    attributes: true,
    childList: true,
    subtree: true,
  });
};

async function probeOf(page: Page): Promise<Probe> {
  return page.evaluate(() => (window as unknown as { __boot: Probe }).__boot);
}

interface Blank {
  from: number;
  to: number;
  /** O intervalo ainda estava aberto na última amostra: a tela ficou em branco e não voltou. */
  open: boolean;
}

/** Os intervalos seguidos sem esqueleto de abertura, sem osso na tela e sem texto nela: a tela estava em branco. */
function blankStretches(samples: Sample[]): Blank[] {
  const stretches: Blank[] = [];
  let from: number | null = null;
  for (const sample of samples) {
    const blank = !sample.cover && !sample.bones && !sample.text;
    if (blank && from === null) from = sample.t;
    if (!blank && from !== null) {
      stretches.push({ from, to: sample.t, open: false });
      from = null;
    }
  }
  if (from !== null) stretches.push({ from, to: samples[samples.length - 1].t, open: true });
  return stretches;
}

/**
 * Bem acima de `SLOW_BOOT_MS` (300): um pedaço que demora isto garante que o esqueleto do Angular entra em cena antes de a
 * tela chegar, em vez de a abertura terminar colada no limite e virar, na prática, um caso rápido.
 */
const SLOW_MS = 700;
/**
 * Só a folha de estilos atrasada: a casca e a rota do Treino chegam rápido, e a folha tem de vir bem depois delas para a
 * tela ficar pronta antes dela, mesmo com a máquina ocupada.
 */
const LATE_STYLES_MS = 2000;

interface Scenario {
  name: string;
  /** Atraso do `main` e do `polyfills` (o Angular sobe tarde). */
  main: number;
  /** Atraso de cada pedaço preguiçoso (a casca e a rota do Treino). */
  chunks: number;
  /** Atraso da folha de estilos principal (o Angular pode subir antes dela). */
  styles: number;
  /** O esqueleto do Angular tem de ter aparecido: é o caminho lento da troca. */
  expectAngular?: boolean;
  /** A tela ficou pronta com a folha de estilos ainda a caminho: o caminho `dismissAfterStyles`. */
  expectStylesPending?: boolean;
}

const SCENARIOS: Scenario[] = [
  { name: 'abertura rápida', main: 0, chunks: 0, styles: 0 },
  { name: 'pedaços lentos', main: 0, chunks: SLOW_MS, styles: 0, expectAngular: true },
  {
    name: 'tudo lento',
    main: SLOW_MS,
    chunks: SLOW_MS,
    styles: SLOW_MS,
    expectAngular: true,
  },
  {
    name: 'folha de estilos lenta',
    main: 0,
    chunks: 0,
    styles: LATE_STYLES_MS,
    expectStylesPending: true,
  },
];

/**
 * A entrada em `startTraining` já baixou o `main`, a folha de estilos e os pedaços, e o navegador reaproveitaria tudo: a
 * carga seguinte nem chegaria às rotas do Playwright e o atraso não valeria. Com `no-store` os scripts voltam à rede; a
 * folha de estilos (que o WebKit reaproveita da memória mesmo assim) ganha um endereço novo no documento da carga
 * amostrada, e o atraso vale para ela também.
 */
async function keepAssetsOutOfCache(
  context: BrowserContext,
  path: string,
  coldStyles: boolean,
): Promise<void> {
  await context.route(/\.(js|css)(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'cache-control': 'no-store' },
    });
  });
  if (!coldStyles) return;
  await context.route(
    (url) => url.pathname === path,
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const response = await route.fetch();
      const body = (await response.text()).replace(/(styles-[\w-]+\.css)/g, '$1?cold');
      const { 'content-length': _length, ...headers } = response.headers();
      return route.fulfill({ response, headers, body });
    },
  );
}

async function delayRequests(context: BrowserContext, pattern: RegExp, ms: number): Promise<void> {
  if (ms <= 0) return;
  await context.route(pattern, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    // A página pode ter ido embora durante a espera (fim do teste): não há o que entregar.
    await route.fallback().catch(() => undefined);
  });
}

/**
 * Chega ao marco de "a tela está pronta": a casca marcou `data-screen-ready`, a tela roteada tem conteúdo de verdade (texto
 * visível, sem osso de esqueleto) e as duas coberturas (a estática e a do Angular) já saíram do documento.
 */
async function waitForScreen(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const ready = document.querySelector('[data-screen-ready="training"]');
      const screen = document.querySelector('app-training-page router-outlet + *');
      if (!ready || !screen || screen.querySelector('.bone, .ui-skeleton')) return false;
      const real = [...screen.querySelectorAll('*')].some(
        (el) =>
          !el.closest('.ui-visually-hidden') &&
          [...el.childNodes].some(
            (n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 2,
          ),
      );
      return (
        real &&
        !document.getElementById('boot-skeleton') &&
        !document.querySelector('app-update-skeleton .bs-root')
      );
    },
    undefined,
    { timeout: 25_000 },
  );
  // Alguns quadros depois do marco: um vazio que só aparecesse logo depois da troca ainda entra na amostra.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 0;
        const next = (): void => {
          if (++frames >= 6) resolve();
          else requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
      }),
  );
}

test.describe('troca do esqueleto de abertura pelo da tela', () => {
  // A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
  test.use({ serviceWorkers: 'block' });

  for (const scenario of SCENARIOS) {
    for (const path of ['/treino/rotinas', '/treino/corpo', '/treino/progresso']) {
      test(`${path} (${scenario.name}): nenhum quadro em branco`, async ({
        page,
        context,
      }, testInfo) => {
        await keepAssetsOutOfCache(context, path, scenario.styles > 0);
        await startTraining(context, page);
        await delayRequests(context, /\/(main|polyfills)-[^/]+\.js$/, scenario.main);
        await delayRequests(context, /\/chunk-[^/]+\.js$/, scenario.chunks);
        await delayRequests(context, /\/styles-[^/]+\.css(\?.*)?$/, scenario.styles);
        // Só a próxima carga é amostrada: a entrada acima já usou o documento.
        await page.addInitScript(sampler);
        await page.goto(path, { waitUntil: 'commit' });
        await waitForScreen(page);

        const { samples, frames } = await probeOf(page);
        const painted = samples.filter((sample) => sample.src === 'frame');
        const blanks = blankStretches(samples);
        await testInfo.attach('amostras', {
          body: JSON.stringify({
            blanks,
            frames,
            n: samples.length,
            painted: painted.length,
            angular: samples.some((sample) => sample.angular),
            stylesLate: samples.some((sample) => sample.marker && sample.stylesPending),
            first: samples.slice(0, 5),
          }),
          contentType: 'application/json',
        });
        expect(frames, 'o laço de quadros rodou').toBeGreaterThan(5);
        expect(painted.length, 'houve amostras depois da pintura').toBeGreaterThan(5);
        expect(painted[0].cover, 'o primeiro quadro já tem o esqueleto de abertura').toBe(true);
        if (scenario.expectAngular) {
          expect(
            samples.some((sample) => sample.angular),
            'o esqueleto do Angular apareceu: o caminho lento rodou',
          ).toBe(true);
        }
        if (scenario.expectStylesPending) {
          expect(
            samples.some((sample) => sample.marker && sample.stylesPending),
            'a tela ficou pronta antes da folha de estilos: o caminho dismissAfterStyles rodou',
          ).toBe(true);
        }
        expect(blanks, 'intervalos sem nada desenhado (ms desde o início da página)').toEqual([]);
      });
    }
  }
});
