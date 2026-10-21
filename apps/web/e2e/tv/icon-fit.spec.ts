import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Locator, Page, TestInfo } from '@playwright/test';
import { GUEST, IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { FIT_CASES, FitCase } from './icon-fit-icons';
import {
  MockShortcut,
  TvMock,
  emitSse,
  installFakeEventSource,
  mockTvApi,
  sseUrls,
} from './tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde os prints vão (a pasta de resultados do Playwright, a menos que o executor aponte outra). */
const SHOTS = process.env['ICON_FIT_SHOTS'] ?? 'test-results';
/** Lado do azulejo da fileira de cima. */
const TILE = 60;

let identity: IdentityMock;
let tv: TvMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  tv = await mockTvApi(context, identity);
  await installFakeEventSource(page);
});

async function signIn(page: Page) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function showTv(page: Page) {
  await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
  await emitSse(page, 'tv.state', tv.state);
  await emitSse(page, 'tv.shortcuts', tv.shortcuts);
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeVisible();
}

async function openTv(page: Page) {
  await signIn(page);
  await page.goto('/tv');
  await showTv(page);
}

/** Um atalho por caso, na ordem dada, com o ícone sintético de cada um. */
function shortcutsFor(cases: readonly FitCase[]): MockShortcut[] {
  return cases.map((item, index) => ({
    id: `00000000-0000-4000-8000-0000000004${String(index).padStart(2, '0')}`,
    position: index + 1,
    package: `exemplo.ajuste.app${index + 1}`,
    tvLabel: item.name,
    customLabel: null,
    enabled: true,
    installed: true,
    iconDataUri: item.uri,
  }));
}

const button = (root: Page | Locator, name: string) =>
  root.getByRole('button', { name, exact: true });
const appsDialog = (page: Page) => page.getByRole('dialog', { name: 'Apps da TV' });

async function settleMotion(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/**
 * Um print da janela inteira, lido de volta como imagem. O print do elemento sozinho dispararia, no WebKit, o aviso de CSP
 * da folha que a ferramenta injeta; o `screenshot` do projeto sabe silenciá-lo, e as medidas saem do print da janela.
 */
interface Shot {
  readonly png: Buffer;
  readonly ratio: number;
}

async function shoot(page: Page, info: TestInfo): Promise<Shot> {
  const path = info.outputPath(`pixels-${String(Date.now())}.png`);
  await screenshot(page, path);
  const png = readFileSync(path);
  rmSync(path, { force: true });
  return { png, ratio: await page.evaluate(() => window.devicePixelRatio) };
}

/** As cores (RGBA) de pontos do print, dados em px de CSS da janela. */
async function sampleColors(
  page: Page,
  shot: Shot,
  points: readonly (readonly [number, number])[],
): Promise<number[][]> {
  return page.evaluate(
    async ({ base64, ratio, spots }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return spots.map(([x, y]) =>
        Array.from(context.getImageData(Math.floor(x * ratio), Math.floor(y * ratio), 1, 1).data),
      );
    },
    { base64: shot.png.toString('base64'), ratio: shot.ratio, spots: points },
  );
}

/** Claro como o neutro do azulejo (#eef2ee) ou o branco: nenhum canal abaixo de 205. */
const isLight = ([r, g, b]: number[]) => Math.min(r, g, b) >= 205;

/** O ícone já carregou e já foi medido (um ícone com cor própria ganha o fundo da borda; os outros ficam como estão). */
async function expectMeasured(tile: Locator, item: FitCase) {
  const image = tile.locator('img');
  await expect
    .poll(() =>
      image.evaluate(
        (el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true);
  if (item.own) {
    await expect
      .poll(() => tile.evaluate((el) => (el as HTMLElement).style.backgroundColor))
      .not.toBe('');
  }
}

/** O fator de escala do `transform` da imagem (1 quando não há). */
const imageScale = (tile: Locator) =>
  tile.locator('img').evaluate((el) => {
    const matrix = getComputedStyle(el).transform;
    if (matrix === 'none') return 1;
    return Number(/matrix\(([^,]+),/.exec(matrix)![1]);
  });

/**
 * Mede o azulejo no navegador, pelo que ele desenha de verdade (um print da janela): o ícone enche o azulejo (`cover`,
 * sem folga), e quando o ícone tem cor própria nenhum ponto perto das bordas ou dos cantos é claro. Os pontos ficam a
 * 3 px das bordas (dentro do fio do azulejo) e nos cantos, por dentro do arredondamento.
 */
async function expectFilledTile(
  page: Page,
  info: TestInfo,
  tile: Locator,
  item: FitCase,
  where: string,
) {
  const label = `${item.name} (${where})`;
  await expectMeasured(tile, item);

  const style = await tile.locator('img').evaluate((el) => {
    const css = getComputedStyle(el);
    const host = el.parentElement!.getBoundingClientRect();
    return {
      objectFit: css.objectFit,
      padding: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft],
      // A caixa de layout (sem o `transform` do recorte) é a do azulejo.
      same: [
        (el as HTMLElement).offsetWidth - host.width,
        (el as HTMLElement).offsetHeight - host.height,
      ],
    };
  });
  expect(style.objectFit, label).toBe('cover');
  expect(style.padding, `${label}: sem folga interna`).toEqual(['0px', '0px', '0px', '0px']);
  for (const delta of style.same)
    expect(Math.abs(delta), `${label}: a imagem é o azulejo`).toBeLessThan(0.6);

  const scale = await imageScale(tile);
  if (item.trimmed) {
    expect(scale, `${label}: a margem própria foi aparada`).toBeGreaterThan(1.1);
    expect(scale, `${label}: sem cortar o desenho`).toBeLessThan(1.4);
  } else {
    expect(scale, `${label}: sem margem a aparar`).toBeLessThan(1.05);
  }
  if (!item.own) return;

  // Inteiro à vista (no meio da faixa que rola): um azulejo meio escondido mostraria o fundo da página nos pontos de fora.
  await tile.evaluate((el) => el.scrollIntoView({ block: 'nearest', inline: 'center' }));
  const box = (await tile.boundingBox())!;
  const side = box.width;
  const screenSize = page.viewportSize()!;
  expect(box.x, `${label}: azulejo à vista`).toBeGreaterThanOrEqual(0);
  expect(box.x + side, `${label}: azulejo à vista`).toBeLessThanOrEqual(screenSize.width);
  const strip = await page.locator('.shortcuts').boundingBox();
  if (where === 'fileira' && strip) {
    expect(box.x + side, `${label}: dentro da faixa`).toBeLessThanOrEqual(
      strip.x + strip.width + 0.5,
    );
    expect(box.x, `${label}: dentro da faixa`).toBeGreaterThanOrEqual(strip.x - 0.5);
  }
  const radius = await tile.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
  const along = Array.from({ length: 9 }, (_, index) => side * (0.2 + (0.6 * index) / 8));
  const corner = radius * (1 - Math.SQRT1_2) + 2.5;
  const at = (dx: number, dy: number): [number, number] => [box.x + dx, box.y + dy];
  const points: [number, number][] = [
    ...along.flatMap((t): [number, number][] => [
      at(t, 3),
      at(t, side - 3),
      at(3, t),
      at(side - 3, t),
    ]),
    at(corner, corner),
    at(side - corner, corner),
    at(corner, side - corner),
    at(side - corner, side - corner),
  ];
  const colors = await sampleColors(page, await shoot(page, info), points);
  const light = colors
    .map((color, index) => ({ color, at: points[index] }))
    .filter(({ color }) => color[3] === 255 && isLight(color));
  expect(light, `${label}: ponto claro nas bordas ou nos cantos do azulejo`).toEqual([]);
}

test.describe('ícone sem borda: o desenho do app enche o azulejo', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`na fileira de cima e no painel Apps, com todos os formatos de ícone (${scheme})`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      tv.shortcuts = shortcutsFor(FIT_CASES);
      await openTv(page);

      const row = page.locator('.shortcuts .shortcut app-tv-app-icon');
      await expect(row).toHaveCount(FIT_CASES.length);
      for (const [index, item] of FIT_CASES.entries()) {
        await expectFilledTile(page, info, row.nth(index), item, 'fileira');
      }
      await page.locator('.shortcuts').evaluate((el) => el.scrollTo({ left: 0 }));
      await expectNoHorizontalScroll(page);
      await screenshot(page, join(SHOTS, `icon-fit-controle-${scheme}-${info.project.name}.png`));

      await button(page, 'Apps da TV').click();
      const dialog = appsDialog(page);
      await expect(dialog).toBeVisible();
      await settleMotion(page);
      const tiles = dialog.locator('.item .art app-tv-app-icon');
      await expect(tiles).toHaveCount(FIT_CASES.length);
      for (const [index, item] of FIT_CASES.entries()) {
        await tiles.nth(index).scrollIntoViewIfNeeded();
        await expectFilledTile(page, info, tiles.nth(index), item, 'painel Apps');
      }
      await dialog.locator('.item').first().scrollIntoViewIfNeeded();
      await settleMotion(page);
      await screenshot(page, join(SHOTS, `icon-fit-painel-${scheme}-${info.project.name}.png`));
    });
  }

  test('o canto arredondado recorta também a imagem ampliada (o WebKit não o aplica sozinho a um filho transformado)', async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme: 'light' });
    tv.shortcuts = shortcutsFor([FIT_CASES[0]]);
    await openTv(page);
    const tile = page.locator('.shortcuts .shortcut app-tv-app-icon').first();
    await expectMeasured(tile, FIT_CASES[0]);
    const box = (await tile.boundingBox())!;
    // O ícone do CineVS é preto até a borda: logo depois do arco o pixel é o do botão, claro, e bem dentro é preto.
    const [outside, inside] = await sampleColors(page, await shoot(page, info), [
      [box.x + 0.8, box.y + 0.8],
      [box.x + 10, box.y + 10],
    ]);
    expect(isLight(outside), 'fora do arco aparece o fundo do botão').toBe(true);
    expect(Math.max(...inside.slice(0, 3)), 'dentro do arco o ícone é escuro').toBeLessThan(60);
  });

  test('o mesmo ícone em outro azulejo já nasce ajustado, sem uma segunda medida', async ({
    page,
  }) => {
    tv.shortcuts = shortcutsFor([FIT_CASES[0], FIT_CASES[0], FIT_CASES[0]]);
    await openTv(page);
    const tiles = page.locator('.shortcuts .shortcut app-tv-app-icon');
    await expect(tiles).toHaveCount(3);
    const scales: number[] = [];
    for (let index = 0; index < 3; index++) {
      await expectMeasured(tiles.nth(index), FIT_CASES[0]);
      scales.push(await imageScale(tiles.nth(index)));
    }
    expect(scales[1]).toBeCloseTo(scales[0], 3);
    expect(scales[2]).toBeCloseTo(scales[0], 3);
    // O painel mostra o mesmo ícone: já vem medido, com o mesmo recorte da fileira.
    await button(page, 'Apps da TV').click();
    await settleMotion(page);
    const panel = appsDialog(page).locator('.item .art app-tv-app-icon').first();
    await expectMeasured(panel, FIT_CASES[0]);
    expect(await imageScale(panel)).toBeCloseTo(scales[0], 3);
  });
});

/** Quanto sobra (em px) entre a borda da fileira e o primeiro e o último azulejo. */
async function rowGaps(page: Page) {
  const top = (await page.locator('.top').boundingBox())!;
  const chips = page.locator('.shortcuts .shortcut');
  const first = (await chips.first().boundingBox())!;
  const last = (await chips.last().boundingBox())!;
  return {
    left: first.x - top.x,
    right: top.x + top.width - (last.x + last.width),
    width: first.width,
    height: first.height,
    top,
  };
}

test.describe('atalhos maiores e centralizados', () => {
  test('todos medem 60 px, quadrados, e a fileira fica centralizada quando cabe', async ({
    page,
  }, info) => {
    for (const count of [1, 3, 4]) {
      tv.shortcuts = shortcutsFor(FIT_CASES.slice(0, count));
      if (count === 1) {
        await openTv(page);
      } else {
        await emitSse(page, 'tv.shortcuts', tv.shortcuts);
      }
      await expect(page.locator('.shortcuts .shortcut')).toHaveCount(count);
      const gaps = await rowGaps(page);
      expect(gaps.width, `${count} atalhos: largura`).toBeCloseTo(TILE, 0);
      expect(gaps.height, `${count} atalhos: altura`).toBeCloseTo(TILE, 0);
      expect(
        Math.abs(gaps.left - gaps.right),
        `${count} atalhos: centralizados`,
      ).toBeLessThanOrEqual(1.5);
      expect(gaps.left, `${count} atalhos: sobra dos dois lados`).toBeGreaterThan(8);
      await expectNoHorizontalScroll(page);
      await screenshot(
        page,
        join(SHOTS, `icon-fit-centralizada-${String(count)}-${info.project.name}.png`),
      );
    }
  });

  test('passando da largura a fileira rola alinhada ao início, e o último chega ao fim', async ({
    page,
  }) => {
    tv.shortcuts = shortcutsFor([...FIT_CASES, ...FIT_CASES.slice(0, 4)]);
    await openTv(page);
    const strip = page.locator('.shortcuts');
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await strip.evaluate((el) => el.scrollLeft)).toBe(0);
    const stripBox = (await strip.boundingBox())!;
    const first = (await page.locator('.shortcuts .shortcut').first().boundingBox())!;
    // O primeiro azulejo começa no início da faixa (os 5 px de folga do anel de foco são devolvidos pela margem).
    expect(first.x - stripBox.x).toBeCloseTo(5, 0);
    await strip.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    await expect
      .poll(() => strip.evaluate((el) => el.scrollLeft + el.clientWidth >= el.scrollWidth - 1))
      .toBe(true);
    const last = (await page.locator('.shortcuts .shortcut').last().boundingBox())!;
    expect(last.x + last.width).toBeLessThanOrEqual(stripBox.x + stripBox.width + 0.5);
    expect(last.x).toBeGreaterThanOrEqual(stripBox.x);
    await expectNoHorizontalScroll(page);
  });

  test('o controle segue sem rolar, com o anel grande e todos os alvos com 44 px ou mais', async ({
    page,
  }, info) => {
    tv.shortcuts = shortcutsFor(FIT_CASES.slice(0, 5));
    await openTv(page);
    const ring = (await page.locator('.ring').boundingBox())!;
    const stage = (await page.locator('.viewport').boundingBox())!;
    const viewport = page.viewportSize()!;
    const scroll = await page.evaluate(() => ({
      vertical: document.documentElement.scrollHeight - window.innerHeight,
      horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    const bottom = (await page.locator('.bottom').boundingBox())!;
    const tile = (await page.locator('.shortcuts .shortcut').first().boundingBox())!;
    const top = (await page.locator('.top').boundingBox())!;
    console.log(
      `medidas ${info.project.name} ${viewport.width}x${viewport.height}: ` +
        JSON.stringify({
          azulejo: [tile.width, tile.height],
          fileira: top.height,
          anel: [ring.width, ring.height],
          palco: [stage.width, stage.height],
          vazioEmbaixo: viewport.height - (bottom.y + bottom.height),
        }),
    );
    expect(scroll.vertical, 'a tela não rola na vertical').toBeLessThanOrEqual(0);
    expect(scroll.horizontal, 'a tela não rola na horizontal').toBeLessThanOrEqual(0);
    if (info.project.name === 'iphone-12') {
      expect(ring.width, 'anel no 390 x 664').toBeGreaterThanOrEqual(316);
    }
    expect(ring.width).toBeGreaterThanOrEqual(0.85 * Math.min(stage.width, stage.height));
    for (const name of ['Aumentar o volume', 'Voltar', 'OK', 'Apps da TV', 'Página 1 de 3']) {
      const box = (await button(page, name).boundingBox())!;
      expect(box.width, name).toBeGreaterThanOrEqual(43.5);
      expect(box.height, name).toBeGreaterThanOrEqual(43.5);
    }
    for (const chip of await page.locator('.shortcuts .shortcut').all()) {
      const box = (await chip.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(43.5);
      expect(box.height).toBeGreaterThanOrEqual(43.5);
    }
  });

  test.describe('paisagem curta (844 x 390)', () => {
    test.use({ viewport: { width: 844, height: 390 } });

    test('os azulejos medem 60 px, a fileira fica centralizada na coluna da direita e nada rola', async ({
      page,
    }, info) => {
      tv.shortcuts = shortcutsFor(FIT_CASES.slice(0, 4));
      await openTv(page);
      const gaps = await rowGaps(page);
      expect(gaps.width).toBeCloseTo(TILE, 0);
      expect(gaps.height).toBeCloseTo(TILE, 0);
      expect(Math.abs(gaps.left - gaps.right)).toBeLessThanOrEqual(1.5);
      const scroll = await page.evaluate(() => ({
        vertical: document.documentElement.scrollHeight - window.innerHeight,
        horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      expect(scroll.vertical, 'a tela não rola na vertical').toBeLessThanOrEqual(0);
      expect(scroll.horizontal).toBeLessThanOrEqual(0);
      const bottom = (await page.locator('.bottom').boundingBox())!;
      expect(bottom.y + bottom.height).toBeLessThanOrEqual(390);
      await screenshot(page, join(SHOTS, `icon-fit-paisagem-${info.project.name}.png`));
    });
  });

  test('para o convidado (sem a seta de voltar) a fileira também é de 60 px e centralizada', async ({
    page,
  }) => {
    tv.shortcuts = shortcutsFor(FIT_CASES.slice(0, 4));
    const invite = identity.seedInvite();
    await page.goto(`/convite#${invite.token}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Criar sua conta' })).toBeVisible();
    await page.getByLabel('E-mail').fill(GUEST.email);
    await page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
    await page.getByLabel('Repita a senha').fill(GUEST.password);
    await page.getByRole('button', { name: 'Criar conta e entrar' }).click();
    await expect(page).toHaveURL(/\/tv$/);
    await showTv(page);
    await expect(page.getByRole('link', { name: /Início/ })).toHaveCount(0);
    await expect(page.locator('.shortcuts .shortcut')).toHaveCount(4);
    const gaps = await rowGaps(page);
    expect(gaps.width).toBeCloseTo(TILE, 0);
    expect(Math.abs(gaps.left - gaps.right)).toBeLessThanOrEqual(1.5);
    const vertical = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(vertical).toBeLessThanOrEqual(0);
    await expectNoHorizontalScroll(page);
  });
});
