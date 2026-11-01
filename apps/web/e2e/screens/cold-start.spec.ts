import { Page } from '@playwright/test';
import { IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, screenshot, test } from '../fixtures';
import { mockTrainingApi } from '../training/support/training-server';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';

/**
 * Abertura a frio de cada app (contexto limpo, sem cache e sem service worker, rede lenta: o JavaScript chega com
 * atraso e a API só responde quando o teste solta). O que se confere é o que a pessoa vê enquanto espera: o esqueleto
 * com a forma EXATA da tela de destino (não o genérico), desde o primeiro quadro, sem tela em branco no caminho, e a
 * troca para a tela de verdade quando os dados chegam. `PRINTS_DIR` guarda a sequência de prints (só ilustração: nada
 * aqui mede tempo).
 */
test.use({ serviceWorkers: 'block' });

const PRINTS_DIR = process.env['PRINTS_DIR'];
const PRINTS_TAG = process.env['PRINTS_TAG'] ?? 'depois';
/** O JavaScript do app demora este tanto para chegar: a abertura lenta que o dono vê no celular. */
const SCRIPT_DELAY_MS = 600;

type Variant = 'home' | 'tv' | 'training-today' | 'settings';

interface Case {
  readonly name: string;
  readonly path: string;
  readonly variant: Variant;
  /** Seletor -> quantos elementos o desenho tem (a forma). */
  readonly shape: Readonly<Record<string, number>>;
  /** A tela de verdade, quando a API responde. */
  readonly ready: (page: Page) => Promise<void>;
}

const CASES: readonly Case[] = [
  {
    name: 'TV',
    path: '/tv/',
    variant: 'tv',
    shape: {
      '.bs-tv-head .bs-tv-lead .bs-circle': 2,
      '.bs-tv-head > .bs-tv-title': 1,
      '.bs-tv-head .bs-tv-actions .bs-state-dot': 1,
      '.bs-tv-head .bs-tv-actions > .bs-circle': 1,
      '.bs-tv-shortcuts .bs-tile': 3,
      '.bs-ring .bs-ok': 1,
      '.bs-ring .bs-arrow': 4,
      '.bs-tv-dots .bs-pip': 3,
      '.bs-tv-bottom .bs-vpill': 2,
      '.bs-tv-bottom .bs-round-key': 8,
    },
    ready: async (page) => {
      await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeVisible();
    },
  },
  {
    name: 'Treino',
    path: '/treino/',
    variant: 'training-today',
    shape: {
      '.bs-topbar .bs-back': 1,
      '.bs-topbar .bs-title': 1,
      '.bs-hero .bs-cta': 1,
      '.bs-days .bs-day': 7,
      '.bs-training-today-content .bs-stats .bs-stat': 3,
      '.bs-tabs .bs-tab': 3,
    },
    ready: async (page) => {
      await expect(page.locator('app-training-page')).toBeVisible();
    },
  },
  {
    name: 'Configurações',
    path: '/ajustes/',
    variant: 'settings',
    shape: {
      '.bs-topbar .bs-back': 1,
      '.bs-topbar .bs-title': 1,
      '.bs-segments .bs-segment': 3,
      '.bs-group': 2,
      '.bs-group .bs-setting': 6,
    },
    ready: async (page) => {
      await expect(page.getByRole('heading', { name: 'Configurações' })).toBeVisible();
    },
  },
  {
    name: 'Início',
    path: '/',
    variant: 'home',
    shape: {
      '.bs-brand': 1,
      '.bs-home-hero .bs-hero-actions .bone': 2,
      '.bs-home-hero .bone': 5,
      '.bs-modules .bs-module': 8,
    },
    ready: async (page) => {
      await expect(page.locator('main')).toBeVisible();
      await expect
        .poll(async () => (await page.locator('main').boundingBox())?.height ?? 0)
        .toBeGreaterThan(100);
    },
  },
];

/** A varredura repete as rotas que têm desenho próprio nas três entradas que já chegaram a mostrar o genérico. */
const ROUTE_MATRIX: readonly { readonly name: string; readonly path: string; readonly variant: string }[] = [
  { name: 'Início', path: '/', variant: 'home' },
  { name: 'TV', path: '/tv/', variant: 'tv' },
  { name: 'Treino hoje', path: '/treino/', variant: 'training-today' },
  { name: 'Treino rotinas', path: '/treino/rotinas', variant: 'training-list' },
  { name: 'Treino progresso', path: '/treino/progresso', variant: 'training-progress' },
  { name: 'Treino corpo', path: '/treino/corpo', variant: 'training-body' },
  { name: 'Configurações', path: '/ajustes/', variant: 'settings' },
  { name: 'Sistema', path: '/ajustes/sistema', variant: 'settings-system' },
  { name: 'Pessoas', path: '/ajustes/pessoas', variant: 'settings-people' },
  { name: 'Auditoria', path: '/ajustes/auditoria', variant: 'settings-audit' },
  { name: 'Dispositivos', path: '/ajustes/dispositivos', variant: 'settings-devices' },
  { name: 'Perfil', path: '/ajustes/perfil', variant: 'settings-profile' },
  { name: 'Aparência', path: '/ajustes/aparencia', variant: 'settings-appearance' },
];

function drawingClass(variant: string): string {
  if (variant.startsWith('training-')) return 'training';
  if (variant.startsWith('settings-') && variant !== 'settings') return 'detail';
  return variant;
}

function screenMarker(variant: string): string {
  if (variant.startsWith('training-')) return 'training';
  if (['settings-system', 'settings-people', 'settings-audit', 'settings-devices'].includes(variant))
    return 'settings-data';
  return variant;
}

async function expectRouteScreen(page: Page, variant: string) {
  await expect(
    page.locator(
      `[data-screen-ready="${screenMarker(variant)}"], [data-screen-skeleton="${screenMarker(variant)}"]`,
    ).first(),
  ).toBeVisible();
}

async function expectSpecificSkeleton(page: Page, variant: string) {
  const boot = page.locator('#boot-skeleton');
  const drawing = drawingClass(variant);
  await expect(page.locator('html')).toHaveAttribute('data-boot', variant);
  await expect(boot.locator(`.bs-variant.bs-${drawing}`)).toBeVisible();
  await expect(boot.locator('.bs-variant.bs-generic')).toBeHidden();
  await expect(page.locator('app-update-skeleton .bs-generic')).toHaveCount(0);
}

async function expectSpecificOverlay(page: Page, variant: string) {
  const overlay = page.locator('app-update-skeleton .bs-root');
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute('data-boot-variant', variant);
  await expect(overlay.locator(`.bs-variant.bs-${drawingClass(variant)}`)).toBeVisible();
  await expect(overlay.locator('.bs-generic')).toHaveCount(0);
}

let identity: IdentityMock;

/** Segura a API até o teste soltar, e atrasa o JavaScript: a abertura lenta. */
async function slowNetwork(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, SCRIPT_DELAY_MS));
    await route.fallback();
  });
  await page.route('**/api/**', async (route) => {
    await gate;
    await route.fallback();
  });
  return release;
}

/**
 * Vigia a tela quadro a quadro desde a navegação, inclusive antes do primeiro esqueleto: todo quadro sem esqueleto
 * (o estático ou o do Angular) e sem conteúdo de verdade é o buraco branco que a abertura lenta não pode mostrar.
 */
async function watchForBlank(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __blank: number };
    w.__blank = 0;
    const tick = () => {
      const visible = (element: Element | null) => {
        if (!element) return false;
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(element).display !== 'none';
      };
      const skeleton =
        visible(document.getElementById('boot-skeleton')) ||
        visible(document.querySelector('app-update-skeleton .bs-root'));
      if (!skeleton) {
        const screen = document.querySelector('[data-screen-ready], [data-screen-skeleton]');
        const filled = visible(screen);
        if (!filled) w.__blank += 1;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function print(page: Page, name: string, step: string, project: string) {
  if (!PRINTS_DIR) return;
  await screenshot(page, `${PRINTS_DIR}/${PRINTS_TAG}-${name}-${project}-${step}.png`);
}

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  await mockTvApi(context, identity);
  await mockTrainingApi(context);
  await installFakeEventSource(page);
  await watchForBlank(page);
});

for (const scenario of CASES) {
  test(`${scenario.name}: a abertura a frio mostra o desenho da própria tela, sem tela em branco e sem o genérico`, async ({
    page,
  }, info) => {
    const release = await slowNetwork(page);
    const shortName = scenario.variant;
    await page.goto(scenario.path, { waitUntil: 'commit' });

    // 1. O esqueleto estático: escolhido pelo endereço, antes de o Angular subir.
    const boot = page.locator('#boot-skeleton');
    await expect(page.locator('html')).toHaveAttribute('data-boot', scenario.variant);
    const drawingClass = scenario.variant.startsWith('training-') ? 'training' : scenario.variant;
    const drawing = boot.locator(`.bs-variant.bs-${drawingClass}`);
    await expect(drawing).toBeVisible();
    for (const other of CASES.filter((item) => item.variant !== scenario.variant)) {
      await expect(boot.locator(`.bs-variant.bs-${other.variant}`)).toBeHidden();
    }
    await expect(boot.locator('.bs-variant.bs-generic')).toBeHidden();
    for (const [selector, count] of Object.entries(scenario.shape)) {
      await expect(drawing.locator(selector), selector).toHaveCount(count);
    }
    // Cobre a tela inteira, sem rolagem e com os ossos à vista.
    const viewport = page.viewportSize()!;
    const box = (await boot.boundingBox())!;
    expect(box.width).toBe(viewport.width);
    expect(box.height).toBe(viewport.height);
    expect(await drawing.locator('.bone').count()).toBeGreaterThan(8);
    await print(page, shortName, '1-estatico', info.project.name);

    // 2. O Angular sobe e, com a primeira tela ainda esperando, desenha o mesmo esqueleto por cima.
    const overlay = page.locator('app-update-skeleton .bs-root');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator(`.bs-variant.bs-${drawingClass}`)).toBeVisible();
    await expect(overlay.locator('.bs-variant.bs-generic')).toHaveCount(0);
    for (const [selector, count] of Object.entries(scenario.shape)) {
      await expect(overlay.locator(selector), selector).toHaveCount(count);
    }
    await print(page, shortName, '2-angular', info.project.name);

    // 3. A API responde: a tela de verdade entra e os dois esqueletos saem.
    release();
    await scenario.ready(page);
    await expectRouteScreen(page, scenario.variant);
    await expect(boot).toHaveCount(0);
    await expect(overlay).toHaveCount(0);
    await print(page, shortName, '3-pronta', info.project.name);

    // Nunca houve um quadro sem esqueleto e sem conteúdo no meio do caminho.
    expect(await page.evaluate(() => (window as unknown as { __blank: number }).__blank)).toBe(0);
  });
}

for (const scenario of ROUTE_MATRIX) {
  test(`${scenario.name}: abertura fria atrasada não cai no genérico nem deixa corpo vazio`, async ({ page }) => {
    const release = await slowNetwork(page);
    await page.goto(scenario.path, { waitUntil: 'commit' });
    await expectSpecificSkeleton(page, scenario.variant);
    release();
    await expectRouteScreen(page, scenario.variant);
    await expect(page.locator('#boot-skeleton')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __blank: number }).__blank)).toBe(0);
  });

  test(`${scenario.name}: vindo da Início não mostra o genérico nem corpo vazio`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    const release = await slowNetwork(page);
    if (scenario.path === '/') {
      await expect(page.locator('.bs-generic')).toHaveCount(0);
      release();
      await expectRouteScreen(page, scenario.variant);
      expect(await page.evaluate(() => (window as unknown as { __blank: number }).__blank)).toBe(0);
      return;
    }
    await page.evaluate((path) => {
      history.pushState({}, '', path);
      dispatchEvent(new PopStateEvent('popstate'));
    }, scenario.path);
    await expectSpecificOverlay(page, scenario.variant);
    release();
    await expectRouteScreen(page, scenario.variant);
    await expect(page.locator('#boot-skeleton')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __blank: number }).__blank)).toBe(0);
  });

  test(`${scenario.name}: Atualizar mantém o desenho específico até a página montar`, async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem('uniover.update.refreshing', String(Date.now())));
    const release = await slowNetwork(page);
    await page.goto(scenario.path, { waitUntil: 'commit' });
    await expectSpecificSkeleton(page, scenario.variant);
    await expect(page.locator('app-update-skeleton .bs-root')).toBeVisible();
    release();
    await expectRouteScreen(page, scenario.variant);
    await expect(page.locator('#boot-skeleton')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __blank: number }).__blank)).toBe(0);
  });
}

test.describe('tema escuro e movimento reduzido', () => {
  test.use({ colorScheme: 'dark', reducedMotion: 'reduce' });

  test('o esqueleto estático segue o tema escuro do sistema e pulsa em vez de deslizar', async ({
    page,
  }, info) => {
    await slowNetwork(page);
    await page.goto('/tv/', { waitUntil: 'commit' });
    const boot = page.locator('#boot-skeleton');
    await expect(boot.locator('.bs-variant.bs-tv')).toBeVisible();
    // Fundo escuro do tema (os mesmos tokens do app) e brilho trocado pela pulsação de "reduzir movimento".
    await expect(boot).toHaveCSS('background-color', 'rgb(16, 21, 18)');
    await expect(boot.locator('.bs-tile').first()).toHaveCSS('animation-name', 'ui-pulse');
    await print(page, 'tv-escuro', '1-estatico', info.project.name);
  });
});
