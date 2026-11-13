import { Page, TestInfo } from '@playwright/test';
import { mockIdentityApi } from '../auth/identity-mock';
import { expect, test } from '../fixtures';
import { mockPcApi } from '../pc/pc-mock';
import { mockShoppingApi } from '../shopping/shopping-mock';
import { emitSse, installFakeEventSource, mockTvApi, sseUrls } from '../tv/tv-mock';
import { startTraining, openTraining } from '../training/support/training-pages';
import { SEED_ROUTINE_IDS } from '../training/support/training-seed';
import { afterFrames, settle } from './screen-helpers';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

/**
 * A varredura de "nada tocável sob a barra do sistema". Playwright não simula `env(safe-area-inset-bottom)`; o app lê a
 * área segura de `--safe-inset` (styles.css). O teste põe nela o que cada aparelho-alvo informa: 34 px do home indicator
 * no iPhone 12 e 48 px da barra de 3 botões no Galaxy S23 FE (o pior caso do Android: a barra inteira dentro da janela).
 * Para cada tela, com a faixa inferior simulada, confere (1) o que está fixo ou colado embaixo, sem rolar nada, e (2) tudo
 * o que é tocável depois de rolar até o fim: nenhum alvo pode ter um pixel dentro da faixa.
 */
const INSET: Record<string, number> = { 'iphone-12': 34, 's23-fe': 48 };
const KEYBOARD = 300;

const insetOf = (info: TestInfo) => INSET[info.project.name] ?? 34;

async function simulateInset(page: Page, px: number): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.style.setProperty('--safe-inset', `${value}px`);
  }, px);
  await afterFrames(page);
}

/** Um `visualViewport` falso: a altura é a da janela menos o que o teclado cobre (o Playwright não abre teclado). */
async function installFakeKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let covered = 0;
    const target = new EventTarget();
    Object.defineProperties(target, {
      height: { get: () => window.innerHeight - covered },
      offsetTop: { value: 0 },
    });
    Object.defineProperty(window, 'visualViewport', { value: target, configurable: true });
    (window as unknown as Record<string, unknown>)['__cover'] = (px: number) => {
      covered = px;
      target.dispatchEvent(new Event('resize'));
    };
  });
}

async function cover(page: Page, px = KEYBOARD): Promise<void> {
  await page.evaluate(
    (value) => (window as never as { __cover(px: number): void }).__cover(value),
    px,
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--kb-inset'),
      ),
    )
    .toBe(`${px}px`);
  await afterFrames(page);
}

/**
 * Os alvos tocáveis que invadem a faixa de baixo (`band` px da base da janela). Só conta o que o toque de fato alcança:
 * o ponto do meio do alvo tem de cair nele (o que está coberto, escondido ou cortado não é tocável). Com `pinnedOnly`,
 * só o que está fixo ou colado (`fixed`/`sticky`), porque a página parada pode ter, no meio da rolagem, um item
 * cortado pela borda da janela, e isso é rolagem, não defeito.
 */
async function bandIntruders(page: Page, band: number, pinnedOnly: boolean): Promise<string[]> {
  return page.evaluate(
    ({ band: bandPx, pinned }) => {
      const selector = [
        'button',
        'a[href]',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        'summary',
        '[role="button"]',
        '[role="link"]',
        '[role="tab"]',
        '[role="switch"]',
        '[role="checkbox"]',
        '[tabindex]:not([tabindex="-1"])',
      ].join(',');
      const height = window.innerHeight;
      const width = window.innerWidth;
      const isPinned = (node: Element) => {
        for (let el: Element | null = node; el; el = el.parentElement) {
          const position = getComputedStyle(el).position;
          if (position === 'fixed' || position === 'sticky') return true;
        }
        return false;
      };
      const out: string[] = [];
      for (const node of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const rect = node.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;
        if (rect.right <= 0 || rect.left >= width || rect.top >= height || rect.bottom <= 0)
          continue;
        const style = getComputedStyle(node);
        if (style.visibility !== 'visible' || style.pointerEvents === 'none') continue;
        if (node.closest('[inert]')) continue;
        if (pinned && !isPinned(node)) continue;
        const x = Math.min(Math.max(rect.left + rect.width / 2, 0), width - 1);
        const y = Math.min(Math.max(rect.top + rect.height / 2, 0), height - 1);
        const top = document.elementFromPoint(x, y);
        if (!top || !(node === top || node.contains(top) || top.contains(node))) continue;
        if (rect.bottom > height - bandPx + 0.5) {
          const name =
            node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 30) ?? '';
          out.push(
            `${node.tagName.toLowerCase()}${node.className ? '.' + String(node.className).split(' ')[0] : ''} "${name}" ` +
              `bottom=${Math.round(rect.bottom)} limite=${Math.round(height - bandPx)}`,
          );
        }
      }
      return out;
    },
    { band, pinned: pinnedOnly },
  );
}

/** Parado e depois de rolar até o fim: nada tocável dentro da faixa `band` (área segura, ou teclado). */
async function expectBottomClear(page: Page, band: number): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await afterFrames(page);
  expect(await bandIntruders(page, band, true), 'fixo ou colado, parado').toEqual([]);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await afterFrames(page);
  expect(await bandIntruders(page, band, false), 'depois de rolar até o fim').toEqual([]);
}

/** Abre uma compra do zero no mercado: só então existe a barra de adicionar, fixa embaixo. */
async function startPurchase(page: Page): Promise<void> {
  await page.goto('/compras/mercado');
  await page.getByRole('button', { name: /^Começar do Zero/ }).click();
  await expect(page.getByRole('textbox', { name: 'Item e preço' })).toBeVisible();
}

/** A parte de baixo do elemento. */
async function bottomOf(target: ReturnType<Page['locator']>): Promise<number> {
  const box = (await target.boundingBox())!;
  return box.y + box.height;
}

test.describe('nenhuma tela deixa um alvo tocável sob a barra de baixo do celular', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('Entrar e Início', async ({ context, page }, info) => {
    const identity = await mockIdentityApi(context);
    await mockTvApi(context, identity);
    await installFakeEventSource(page);
    await page.goto('/entrar');
    await expect(page.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
    await simulateInset(page, insetOf(info));
    await expectBottomClear(page, insetOf(info));

    identity.loggedIn = true;
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Bom dia|Boa tarde|Boa noite/);
    await settle(page);
    await simulateInset(page, insetOf(info));
    await expectBottomClear(page, insetOf(info));
  });

  test('Controle da TV: teclas de baixo, atalhos e a folha de desligar', async ({
    context,
    page,
  }, info) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    const tv = await mockTvApi(context, identity);
    await installFakeEventSource(page);
    await page.goto('/tv');
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await emitSse(page, 'tv.state', tv.state);
    await emitSse(page, 'tv.shortcuts', tv.shortcuts);
    await expect(page.getByRole('button', { name: 'Desligar a TV' })).toBeVisible();
    await settle(page);
    const inset = insetOf(info);
    await simulateInset(page, inset);
    await expectBottomClear(page, inset);
    // As teclas de baixo (volume, canal, botões redondos) ficam inteiras acima da faixa, sem rolar.
    const lastKey = page.locator('app-tv-bottom-keys button:visible').last();
    expect(await bottomOf(lastKey)).toBeLessThanOrEqual(page.viewportSize()!.height - inset + 0.5);

    await page.getByRole('button', { name: 'Desligar a TV' }).click();
    const dialog = page.getByRole('dialog', { name: 'Desligar a TV?' });
    await expect(dialog).toBeVisible();
    await settle(page);
    expect(await bandIntruders(page, inset, false), 'folha aberta').toEqual([]);
  });

  test('Controle do PC: abas, mouse, teclado e Trocar janela', async ({ context, page }, info) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    await mockPcApi(context, identity);
    await mockTvApi(context, identity);
    await installFakeEventSource(page);
    const inset = insetOf(info);
    for (const path of ['/pc', '/pc/teclado', '/pc/midia', '/pc/energia', '/pc/mais']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: 'Controle do PC' })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: /Conectado|Sem/ })).toHaveText(
        'Conectado',
      );
      await settle(page);
      await simulateInset(page, inset);
      await expectBottomClear(page, inset);
      const tabs = page.getByRole('navigation', { name: 'Abas do módulo' });
      expect(await bottomOf(tabs), `${path}: abas`).toBeLessThanOrEqual(
        page.viewportSize()!.height + 0.5,
      );
      // O toque mais baixo da barra de abas fica acima da faixa (o fundo da barra é que desce até a borda).
      for (const link of await tabs.getByRole('link').all()) {
        expect(await bottomOf(link), `${path}: aba`).toBeLessThanOrEqual(
          page.viewportSize()!.height - inset + 0.5,
        );
      }
    }
  });

  test('Compras: entrada, lista, Mercado Agora, histórico e detalhes', async ({
    context,
    page,
  }, info) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    await mockShoppingApi(context, identity);
    await mockTvApi(context, identity);
    await installFakeEventSource(page);
    const inset = insetOf(info);
    for (const path of [
      '/compras',
      '/compras/lista',
      '/compras/mercado',
      '/compras/historico',
      '/compras/detalhes',
    ]) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      await settle(page);
      await simulateInset(page, inset);
      await expectBottomClear(page, inset);
    }
    // A barra de adicionar do mercado: o campo e o botão ficam inteiros acima da faixa, parados.
    await startPurchase(page);
    const bar = page.locator('form.ui-action-bar');
    await expect(bar).toBeVisible();
    await simulateInset(page, inset);
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await bottomOf(page.getByRole('textbox', { name: 'Item e preço' }))).toBeLessThanOrEqual(
      page.viewportSize()!.height - inset + 0.5,
    );
  });

  test('Treino: Hoje, barra de abas e editor com barra de ação', async ({
    context,
    page,
  }, info) => {
    await startTraining(context, page);
    const inset = insetOf(info);
    await openTraining(page, '/treino');
    await settle(page);
    await simulateInset(page, inset);
    await expectBottomClear(page, inset);
    for (const path of ['/treino/rotinas', '/treino/exercicios', '/treino/corpo']) {
      await openTraining(page, path);
      await settle(page);
      await simulateInset(page, inset);
      await expectBottomClear(page, inset);
    }
    await openTraining(page, `/treino/rotinas/${SEED_ROUTINE_IDS.a}`);
    await simulateInset(page, inset);
    await expectBottomClear(page, inset);
    await openTraining(page, '/treino/exercicios/novo');
    await simulateInset(page, inset);
    await expectBottomClear(page, inset);
  });

  test('Ajustes e Auditoria com a folha de filtros', async ({ context, page }, info) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    await mockTvApi(context, identity);
    await installFakeEventSource(page);
    const inset = insetOf(info);
    for (const path of ['/ajustes', '/ajustes/aparencia', '/ajustes/seguranca']) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      await settle(page);
      await simulateInset(page, inset);
      await expectBottomClear(page, inset);
    }
  });
});

test.describe('com o teclado aberto a área segura não é somada duas vezes', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installFakeKeyboard(page);
  });

  /** Com o teclado aberto a área segura de baixo passa a valer 0, mesmo com o inset do aparelho informado. */
  async function expectSafeBottomCollapsed(page: Page) {
    const probe = await page.evaluate(() => {
      const el = document.createElement('div');
      el.style.paddingBottom = 'var(--safe-bottom)';
      document.body.append(el);
      const value = getComputedStyle(el).paddingBottom;
      el.remove();
      return value;
    });
    expect(probe).toBe('0px');
  }

  test('o mercado: a barra de adicionar encosta no teclado e volta ao inset quando ele fecha', async ({
    context,
    page,
  }, info) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    await mockShoppingApi(context, identity);
    await mockTvApi(context, identity);
    await installFakeEventSource(page);
    await startPurchase(page);
    const bar = page.locator('form.ui-action-bar');
    await expect(bar).toBeVisible();
    const inset = insetOf(info);
    await simulateInset(page, inset);
    const height = page.viewportSize()!.height;
    // Sem teclado a barra desce até a borda e seu miolo fica acima do inset.
    expect(await bottomOf(bar)).toBeCloseTo(height, 0);
    await cover(page);
    await expectSafeBottomCollapsed(page);
    // Com o teclado a barra encosta nele: nenhum vão de `inset` entre as duas coisas.
    expect(await bottomOf(bar)).toBeCloseTo(height - KEYBOARD, 0);
    expect(await bandIntruders(page, KEYBOARD, true)).toEqual([]);
    await cover(page, 0);
    expect(await bottomOf(bar)).toBeCloseTo(height, 0);
  });

  test('o teclado do PC: as abas encostam no teclado e nada fica abaixo dele', async ({
    context,
    page,
  }, info) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    await mockPcApi(context, identity);
    await mockTvApi(context, identity);
    await installFakeEventSource(page);
    await page.goto('/pc');
    await expect(page.getByRole('status').filter({ hasText: /Conectado|Sem/ })).toHaveText(
      'Conectado',
    );
    await settle(page);
    await simulateInset(page, insetOf(info));
    await page.getByRole('button', { name: 'Teclado', exact: true }).click();
    await expect(page.getByLabel('Digitar no PC')).toBeFocused();
    await cover(page);
    await expectSafeBottomCollapsed(page);
    const tabs = page.getByRole('navigation', { name: 'Abas do módulo' });
    const height = page.viewportSize()!.height;
    expect(await bottomOf(tabs)).toBeCloseTo(height - KEYBOARD, 0);
    expect(await bandIntruders(page, KEYBOARD, true)).toEqual([]);
  });

  test('o Salvar do editor de rotina: a barra encosta no teclado, sem vão extra', async ({
    context,
    page,
  }, info) => {
    await startTraining(context, page);
    await openTraining(page, `/treino/rotinas/${SEED_ROUTINE_IDS.a}`);
    await simulateInset(page, insetOf(info));
    await page.getByLabel('Nome da rotina').fill('Treino A · Peito');
    await cover(page);
    await expectSafeBottomCollapsed(page);
    const bar = page.locator('.ui-action-bar');
    expect(await bottomOf(bar)).toBeCloseTo(page.viewportSize()!.height - KEYBOARD, 0);
    const padding = await bar.evaluate((node) => parseFloat(getComputedStyle(node).paddingBottom));
    // O respiro de baixo é o da própria barra (12 px); o inset do aparelho não entra.
    expect(padding).toBeLessThan(insetOf(info));
  });

  test('o painel de teclado da TV sobe até o teclado sem somar o inset', async ({
    context,
    page,
  }, info) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    const tv = await mockTvApi(context, identity);
    await installFakeEventSource(page);
    await page.goto('/tv');
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await emitSse(page, 'tv.state', tv.state);
    await emitSse(page, 'tv.shortcuts', tv.shortcuts);
    await expect(page.getByRole('button', { name: 'Desligar a TV' })).toBeVisible();
    await simulateInset(page, insetOf(info));
    await page.goto('/tv/teclado');
    const dialog = page.getByRole('dialog', { name: 'Teclado' });
    await expect(dialog).toBeVisible();
    await settle(page);
    await simulateInset(page, insetOf(info));
    await cover(page);
    await expectSafeBottomCollapsed(page);
    // O painel tem o teclado do aparelho e a margem da tela embaixo (e mais nada): nada de 34 ou 48 px a mais.
    const { padding, gutter } = await dialog.evaluate((node) => {
      const probe = document.createElement('div');
      probe.style.paddingBottom = 'var(--gutter)';
      document.body.append(probe);
      const gutterPx = parseFloat(getComputedStyle(probe).paddingBottom);
      probe.remove();
      return { padding: parseFloat(getComputedStyle(node).paddingBottom), gutter: gutterPx };
    });
    expect(padding).toBeCloseTo(gutter + KEYBOARD, 0);
  });
});

test.describe('a cor atrás da barra do sistema é a do fundo da tela', () => {
  const hex = (rgb: string) =>
    '#' +
    (rgb.match(/\d+/g) ?? [])
      .slice(0, 3)
      .map((part) => Number(part).toString(16).padStart(2, '0'))
      .join('');

  async function colors(page: Page) {
    return page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      root: getComputedStyle(document.documentElement).backgroundColor,
      metas: Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((meta) => ({
        media: meta.getAttribute('media') ?? '',
        content: meta.getAttribute('content') ?? '',
        active: window.matchMedia(meta.getAttribute('media') ?? 'all').matches,
      })),
    }));
  }

  for (const scope of ['/entrar', '/tv/', '/pc/', '/treino/', '/compras']) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`${scope} no tema ${scheme}: a meta ativa, o fundo da página e a raiz têm a mesma cor`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await page.goto(scope);
        await expect(page.locator('app-root')).toBeAttached();
        await settle(page);
        const seen = await colors(page);
        const active = seen.metas.filter((meta) => meta.active);
        expect(active.length).toBeGreaterThan(0);
        for (const meta of active) {
          expect(meta.content.toLowerCase()).toBe(hex(seen.body));
        }
        expect(hex(seen.root)).toBe(hex(seen.body));
      });
    }
  }

  test('o tema fixado no app vale nas duas metas, mesmo contra o tema do sistema, e a troca é de uma vez', async ({
    context,
    page,
  }) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    await mockTvApi(context, identity);
    await installFakeEventSource(page);
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.goto('/ajustes/aparencia');
    await expect(page.getByRole('radio', { name: 'Escuro' })).toBeVisible();
    await page.getByRole('radio', { name: 'Escuro' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const dark = await colors(page);
    expect(dark.metas.map((meta) => meta.content.toLowerCase())).toEqual(['#101512', '#101512']);
    expect(hex(dark.body)).toBe('#101512');
    await page.getByRole('radio', { name: 'Claro' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const light = await colors(page);
    expect(light.metas.map((meta) => meta.content.toLowerCase())).toEqual(['#f2f5f1', '#f2f5f1']);
    expect(hex(light.body)).toBe('#f2f5f1');
  });
});
