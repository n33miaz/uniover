import AxeBuilder from '@axe-core/playwright';
import { Locator, Page } from '@playwright/test';
import { IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import {
  HOT_STATE,
  MockShortcut,
  MockTvState,
  SHORTCUTS,
  TvMock,
  emitSse,
  failSse,
  installFakeEventSource,
  mockTvApi,
  sseUrls,
} from './tv-mock';
import { BROKEN_PNG, ICONS, TINY_WEBP, noisyIcon, toDataUri } from './synthetic-icons';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

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

/** Entra, abre /tv e entrega o instantâneo que a API manda ao abrir o fluxo (estado e atalhos). */
async function openTv(page: Page, path = '/tv') {
  await signIn(page);
  await page.goto(path);
  await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
  await emitSse(page, 'tv.state', tv.state);
  await emitSse(page, 'tv.shortcuts', tv.shortcuts);
}

function seriousViolations(violations: { id: string; impact?: string | null }[]) {
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

async function expectNoSeriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(seriousViolations(violations as never)).toEqual([]);
}

async function expectNoVerticalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  expect(overflow, 'a tela não pode rolar na vertical').toBeLessThanOrEqual(0);
}

async function expectTargetSize(locator: Locator, min = 44) {
  const box = await locator.boundingBox();
  expect(box, 'alvo sem caixa na tela').not.toBeNull();
  expect(box!.width, 'largura do alvo').toBeGreaterThanOrEqual(min - 0.5);
  expect(box!.height, 'altura do alvo').toBeGreaterThanOrEqual(min - 0.5);
}

/**
 * Todos os azulejos têm exatamente o mesmo tamanho e são quadrados (largura = altura), com a caixa medida no navegador:
 * ícone quadrado, banner, sem ícone e imagem quebrada ficam iguais. Devolve a medida comum.
 */
async function expectSameSquares(tiles: Locator): Promise<number> {
  const sizes = await tiles.evaluateAll((els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect();
      return { width: box.width, height: box.height };
    }),
  );
  expect(sizes.length, 'azulejos medidos').toBeGreaterThan(0);
  for (const [index, size] of sizes.entries()) {
    expect(size.width, `azulejo ${index + 1}: largura = altura`).toBeCloseTo(size.height, 1);
    expect(size.width, `azulejo ${index + 1}: o mesmo tamanho do primeiro`).toBeCloseTo(
      sizes[0].width,
      1,
    );
  }
  return sizes[0].width;
}

const button = (root: Page | Locator, name: string) =>
  root.getByRole('button', { name, exact: true });
/** Os três pontos do palco, nesta ordem: direções com o OK, números e touchpad. */
const dot = (page: Page, n: 1 | 2 | 3) => button(page, `Página ${n} de 3`);
/** As três páginas do palco ficam no DOM; o resto do controle é fixo, fora delas. */
const numbersPage = (page: Page) => page.locator('.panel').nth(1);

/** O ponto de estado do cabeçalho (um botão) e o painelzinho que ele abre. */
const statusDot = (page: Page, title?: string) =>
  page.getByRole('button', {
    name: title ? `Estado do controle: ${title}` : /^Estado do controle:/,
  });
const statusPanel = (page: Page) => page.locator('app-status-indicator .panel');

/** Os atalhos de cima são só o ícone do app: o nome está no nome acessível (e na dica) do botão. */
async function expectChipNames(page: Page, names: string[]) {
  const chips = page.locator('.shortcuts .shortcut');
  await expect(chips).toHaveCount(names.length);
  for (const [index, name] of names.entries()) {
    await expect(chips.nth(index)).toHaveAccessibleName(name);
  }
}

const appsDialog = (page: Page) => page.getByRole('dialog', { name: 'Apps da TV' });
const keyboardDialog = (page: Page) => page.getByRole('dialog', { name: 'Teclado' });
const keyboardField = (page: Page) => page.getByLabel('Texto para a TV');

const menuDialog = (page: Page) => page.getByRole('dialog', { name: 'Mais opções' });

/** Abre o menu pelos três pontos do cabeçalho. */
async function openMenu(page: Page) {
  await button(page, 'Mais opções').click();
  await expect(menuDialog(page)).toBeVisible();
}

/** Abre o painel Apps pelo menu dos três pontos, o caminho de quem usa a tela (o menu sai antes de o painel abrir). */
async function openApps(page: Page) {
  await openMenu(page);
  await menuDialog(page).getByRole('button', { name: 'Apps da TV' }).click();
  await expect(appsDialog(page)).toBeVisible();
  await expect(menuDialog(page)).toHaveCount(0);
}

/**
 * Espera as animações e transições que têm fim acabarem (o painel sobe e os azulejos entram em escalonado): axe e print
 * só valem com tudo parado, porque a opacidade a meio caminho muda o contraste medido e o desenho.
 */
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

async function openKeyboard(page: Page) {
  await button(page, 'Teclado').click();
  await expect(keyboardDialog(page)).toBeVisible();
  await expect(keyboardField(page)).toBeVisible();
}

/** Os setores do anel têm a caixa do anel inteiro (recortada em triângulo): o toque vai no lado de cada um. */
const RING_SPOT: Record<string, { x: number; y: number }> = {
  'Para cima': { x: 0.5, y: 0.14 },
  'Para baixo': { x: 0.5, y: 0.86 },
  'Para a esquerda': { x: 0.14, y: 0.5 },
  'Para a direita': { x: 0.86, y: 0.5 },
};

async function pressRing(page: Page, name: string) {
  const target = button(page, name);
  const box = (await target.boundingBox())!;
  const spot = RING_SPOT[name];
  await target.click({ position: { x: box.width * spot.x, y: box.height * spot.y } });
}

const sendState = (page: Page, change: Partial<MockTvState>) =>
  emitSse(page, 'tv.state', { ...HOT_STATE, ...change });

/** Rolagem do carrossel do palco: espera o encaixe terminar na página `index` antes de medir. */
async function settlePage(page: Page, index: number) {
  await expect
    .poll(() =>
      page
        .locator('.pager')
        .evaluate((el, i) => Math.abs(el.scrollLeft - i * el.clientWidth), index),
    )
    .toBeLessThanOrEqual(1);
}

/** Deslize de dedo de verdade (só o Chromium tem o toque sintético do CDP). */
async function swipe(page: Page, from: { x: number; y: number }, dx: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y }],
  });
  const steps = 10;
  for (let step = 1; step <= steps; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (dx * step) / steps, y: from.y }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('controle: tela única, sem abas', () => {
  test('cabe na tela sem rolagem e mostra anel, pílulas, botões redondos e o ponto de estado', async ({
    page,
  }, info) => {
    await openTv(page);
    await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
    await expect(statusDot(page, 'Conectada')).toBeVisible();
    await expect(page.getByRole('img', { name: 'Volume 22' })).toBeVisible();
    await expect(button(page, 'Atalho 1')).toBeVisible();
    await expect(button(page, 'Mais opções')).toBeVisible();

    // Sem a barra de abas de baixo e sem as pílulas de estado de antes.
    await expect(page.getByRole('navigation', { name: 'Abas do módulo' })).toHaveCount(0);
    for (const tab of ['Controle', 'Apps', 'Teclado']) {
      await expect(page.getByRole('link', { name: tab, exact: true })).toHaveCount(0);
    }
    await expect(page.getByText('hiberna em')).toHaveCount(0);
    await expect(page.getByText('conectada', { exact: true })).toHaveCount(0);

    await expectNoHorizontalScroll(page);
    await expectNoVerticalScroll(page);
    await screenshot(page, `test-results/tv-control-${info.project.name}.png`);
    await expectNoSeriousViolations(page);
  });

  test('o menu é o botão de três pontos à esquerda, e o Tab segue a ordem da tela', async ({
    page,
  }) => {
    await openTv(page);
    const head = page.locator('header.head');
    // À esquerda ficam a seta e os três pontos do menu; à direita, só o desligar.
    await expect(head.locator('.lead').getByRole('button')).toHaveCount(1);
    await expect(head.locator('.lead').getByRole('button', { name: 'Mais opções' })).toBeVisible();
    await expect(head.locator('.actions').getByRole('button')).toHaveCount(1);
    await expect(
      head.locator('.actions').getByRole('button', { name: 'Desligar a TV' }),
    ).toBeVisible();

    // Do começo para o fim da linha: seta, três pontos, nome, ponto de estado e desligar.
    await head.getByRole('link', { name: 'Voltar ao Início' }).focus();
    const seen: string[] = [];
    for (let step = 0; step < 4; step++) {
      await page.keyboard.press('Tab');
      seen.push(
        await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''),
      );
    }
    expect(seen[0]).toBe('Mais opções');
    expect(seen[1]).toBe('TV, personalizar');
    expect(seen[2]).toMatch(/^Estado do controle:/);
    expect(seen[3]).toBe('Desligar a TV');

    // O botão abre o menu e devolve o foco a ele ao fechar.
    await button(page, 'Mais opções').click();
    await expect(menuDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menuDialog(page)).toHaveCount(0);
    await expect(button(page, 'Mais opções')).toBeFocused();
  });

  test('o endereço antigo /tv/apps e /tv/teclado leva ao controle com o painel aberto', async ({
    page,
  }) => {
    await openTv(page, '/tv/apps');
    await expect(appsDialog(page)).toBeVisible();
    await expect(page).toHaveURL(/\/tv$/);
    await page.keyboard.press('Escape');
    await expect(appsDialog(page)).toHaveCount(0);

    await page.goto('/tv/teclado');
    await expect(keyboardDialog(page)).toBeVisible();
    await expect(page).toHaveURL(/\/tv$/);
    // Recarregar não reabre o painel: o parâmetro saiu do endereço.
    await page.reload();
    await expect(button(page, 'Mais opções')).toBeVisible();
    await expect(button(page, 'Atalho 1')).toBeVisible();
    await expect(keyboardDialog(page)).toHaveCount(0);
  });

  test('anel, pílulas, botões redondos e demais alvos têm 44 px ou mais', async ({ page }) => {
    await openTv(page);
    const targets = [
      'Aumentar o volume',
      'Diminuir o volume',
      'Próximo canal',
      'Canal anterior',
      'Voltar',
      'Início da TV',
      'Menu',
      'Mudo',
      'Reproduzir ou pausar',
      'Anterior',
      'Próxima',
      'Teclado',
      'Desligar a TV',
      'Mais opções',
      'Atalho 1',
      'Página 1 de 3',
      'Página 2 de 3',
      'Página 3 de 3',
    ];
    for (const name of targets) await expectTargetSize(button(page, name));
    await expectTargetSize(button(page, 'OK'));
    await expectTargetSize(statusDot(page));
    // O setor do anel é um triângulo na caixa do anel inteiro; o ícone dele é o alvo visível.
    for (const name of Object.keys(RING_SPOT)) {
      await expectTargetSize(button(page, name).locator('.glyph'));
      await expectTargetSize(button(page, name));
    }
  });

  test('os botões de baixo cresceram: círculos maiores e pílulas estreitas, de botões de 50 x 52 px ou mais', async ({
    page,
  }, info) => {
    await openTv(page);
    // No 390 (358 úteis) cabem círculos de 59,25 px; no 411 (379 úteis), 64,5 px. A pílula ficou estreita (52 px) de
    // propósito: é a largura que ela devolve que dá o círculo maior.
    const minRound = info.project.name === 'iphone-12' ? 59 : 62;
    const round = (await button(page, 'Voltar').boundingBox())!;
    const pill = (await page.getByRole('group', { name: 'Volume' }).boundingBox())!;
    const channel = (await page.getByRole('group', { name: 'Canal' }).boundingBox())!;
    expect(round.width, 'botão redondo é círculo').toBeCloseTo(round.height, 0);
    expect(round.width, 'círculo maior que antes').toBeGreaterThanOrEqual(minRound);
    expect(pill.width, 'pílula de volume de 52 px').toBeCloseTo(52, 0);
    expect(channel.width, 'pílula de canal de 52 px').toBeCloseTo(52, 0);
    expect(pill.height, 'pílula de volume não ficou mais baixa').toBeGreaterThanOrEqual(127);
    expect(pill.height, 'e o bloco de baixo não passa de 142 px').toBeLessThanOrEqual(142.5);
    // Cada botão da pílula é um alvo confortável para o polegar: 50 px de toque por 52 de altura.
    for (const name of [
      'Aumentar o volume',
      'Diminuir o volume',
      'Próximo canal',
      'Canal anterior',
    ]) {
      const box = (await button(page, name).boundingBox())!;
      expect(box.width, name).toBeGreaterThanOrEqual(49.5);
      expect(box.height, name).toBeGreaterThanOrEqual(51.5);
    }
    await expectNoVerticalScroll(page);
    await expectNoHorizontalScroll(page);
  });

  test('cada botão da primeira página manda a tecla certa, uma vez por toque', async ({ page }) => {
    await openTv(page);
    const expected: [string, string][] = [
      ['Aumentar o volume', 'VOLUME_UP'],
      ['Diminuir o volume', 'VOLUME_DOWN'],
      ['Próximo canal', 'CHANNEL_UP'],
      ['Canal anterior', 'CHANNEL_DOWN'],
      ['Voltar', 'BACK'],
      ['Início da TV', 'HOME'],
      ['Menu', 'MENU'],
      ['Mudo', 'MUTE'],
      ['Reproduzir ou pausar', 'PLAY_PAUSE'],
      ['Anterior', 'MEDIA_PREVIOUS'],
      ['Próxima', 'MEDIA_NEXT'],
      ['OK', 'OK'],
    ];
    for (const [name, key] of expected) {
      const before = tv.keysSent().length;
      await button(page, name).click();
      await expect.poll(() => tv.keysSent().slice(before)).toEqual([key]);
    }
    const arrows: [string, string][] = [
      ['Para cima', 'UP'],
      ['Para baixo', 'DOWN'],
      ['Para a esquerda', 'LEFT'],
      ['Para a direita', 'RIGHT'],
    ];
    for (const [name, key] of arrows) {
      const before = tv.keysSent().length;
      await pressRing(page, name);
      await expect.poll(() => tv.keysSent().slice(before)).toEqual([key]);
    }
    // Nenhuma tecla foi POWER (desligar tem rota própria) e nenhuma passou pela passkey.
    expect(tv.keysSent()).not.toContain('POWER');
    expect(identity.requests.some((r) => r.path.startsWith('/step-up'))).toBe(false);
  });

  test('um toque de dedo manda a tecla uma vez, nos botões e no setor do anel', async ({
    page,
  }) => {
    await openTv(page);
    const menu = (await button(page, 'Menu').boundingBox())!;
    await page.touchscreen.tap(menu.x + menu.width / 2, menu.y + menu.height / 2);
    await expect.poll(() => tv.keysSent()).toEqual(['MENU']);

    const up = (await button(page, 'Para cima').boundingBox())!;
    await page.touchscreen.tap(up.x + up.width / 2, up.y + up.height * 0.14);
    await expect.poll(() => tv.keysSent()).toEqual(['MENU', 'UP']);
    await page.waitForTimeout(700);
    expect(tv.keysSent()).toEqual(['MENU', 'UP']);
  });

  test('segurar volume e setas repete cerca de 4 por segundo e para ao soltar', async ({
    page,
  }) => {
    await openTv(page);
    const target = button(page, 'Aumentar o volume');
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1500);
    await page.mouse.up();
    // Espera de 400 ms e depois uma a cada 250 ms: em 1,5 s cabem de 3 a 5, e o clique do fim não soma uma a mais.
    const held = tv.keysSent().filter((key) => key === 'VOLUME_UP').length;
    expect(held).toBeGreaterThanOrEqual(3);
    expect(held).toBeLessThanOrEqual(6);
    await page.waitForTimeout(700);
    expect(tv.keysSent().filter((key) => key === 'VOLUME_UP').length).toBe(held);
  });

  test('estado do volume vem do servidor, nunca do botão', async ({ page }) => {
    await openTv(page);
    await expect(page.getByRole('img', { name: 'Volume 22' })).toBeVisible();
    await button(page, 'Aumentar o volume').click();
    await expect.poll(() => tv.keysSent()).toEqual(['VOLUME_UP']);
    await expect(page.getByRole('img', { name: 'Volume 22' })).toBeVisible();
    await sendState(page, { volume: 23 });
    await expect(page.getByRole('img', { name: 'Volume 23' })).toBeVisible();
  });
});

test.describe('controle: fileira de atalhos', () => {
  test('os atalhos são azulejos que abrem o app ao toque, como "Atalho n" quando nada os nomeia', async ({
    page,
  }) => {
    await openTv(page);
    for (const n of [1, 2, 3]) await expect(button(page, `Atalho ${n}`)).toBeVisible();
    // O pacote não aparece na tela de controle.
    await expect(page.getByText('exemplo.pacote')).toHaveCount(0);
    // O chip "Apps" saiu da fileira: o painel abre pelo menu dos três pontos do cabeçalho.
    await expect(page.locator('.apps-chip')).toHaveCount(0);

    await button(page, 'Atalho 2').click();
    await expect.poll(() => tv.count(`/shortcuts/${tv.shortcuts[1].id}/launch`)).toBe(1);
    await expect(page.getByText('Atalho 2 aberto na TV.')).toBeVisible();

    // Um nome dado pelo dono, chegando pelo fluxo, passa a valer.
    await emitSse(
      page,
      'tv.shortcuts',
      tv.shortcuts.map((s) => (s.position === 2 ? { ...s, customLabel: 'Sala' } : s)),
    );
    await expect(button(page, 'Sala')).toBeVisible();
    await expect(button(page, 'Atalho 2')).toHaveCount(0);
  });

  test('o nome do atalho é o do dono, depois o que o agente publica para o app, só então "Atalho n"', async ({
    page,
  }) => {
    tv.shortcuts = tv.shortcuts.map((s) => ({
      ...s,
      customLabel: s.position === 1 ? 'Sala' : null,
      tvLabel: s.position <= 2 ? ['YouTube', 'Spotify'][s.position - 1] : null,
    }));
    await openTv(page);
    await expectChipNames(page, ['Sala', 'Spotify', 'Atalho 3']);

    // O mesmo nome nos azulejos do painel Apps, e a busca acha pelo nome que o agente publicou.
    await openApps(page);
    const names = appsDialog(page).locator('.item .name');
    await expect(names).toHaveText(['Sala', 'Spotify', 'Atalho 3']);
    await appsDialog(page).getByRole('searchbox', { name: 'Buscar app' }).fill('spot');
    await expect(names).toHaveText(['Spotify']);
    await button(appsDialog(page), 'Editar').click();
    await button(appsDialog(page), 'Renomear Spotify').click();
    await expect(appsDialog(page).getByLabel('Nome do atalho')).toHaveValue('');
  });

  test('os atalhos seguem a ordem de posição da API', async ({ page }) => {
    tv.shortcuts = [3, 1, 2].map((position) => ({
      ...tv.shortcuts[position - 1],
      customLabel: `App ${position}`,
    }));
    await openTv(page);
    // A API entrega por posição e o app mantém essa ordem (aqui a lista chega embaralhada e sai por posição).
    await expectChipNames(page, ['App 1', 'App 2', 'App 3']);
  });

  test('sem atalho ativo o dono vê sugestões da altura de um azulejo, sem salto e sem texto de erro', async ({
    page,
  }) => {
    await openTv(page);
    const tile = (await page.locator('.shortcuts .shortcut').first().boundingBox())!;
    const stageTop = (await page.locator('.viewport').boundingBox())!.y;

    await emitSse(page, 'tv.shortcuts', []);
    const suggestions = page.locator('.shortcuts .shortcut.suggestion');
    await expect(suggestions.first()).toBeVisible();
    // Nenhuma é um atalho de verdade, e a dica de texto deu lugar a elas.
    await expect(page.locator('.shortcuts .shortcut:not(.suggestion)')).toHaveCount(0);
    await expect(page.getByText('Fixe apps aqui: abra o menu, no topo.')).toHaveCount(0);
    for (const name of ['YouTube', 'Netflix', 'Prime Video']) {
      await expect(
        page.getByRole('button', { name: `Sugestão: ${name}`, exact: true }),
      ).toBeVisible();
    }
    // Quantas cabem vem da largura medida da faixa: lado a lado, sem rolar e com folga; uma a mais não caberia.
    const strip = (await page.locator('app-tv-shortcut-row .top').boundingBox())!;
    const count = await suggestions.count();
    expect(count).toBe(Math.min(6, Math.floor((strip.width - 8) / 68)));
    const first = (await suggestions.first().boundingBox())!;
    const last = (await suggestions.last().boundingBox())!;
    expect(first.x, 'folga à esquerda').toBeGreaterThanOrEqual(strip.x + 8 - 1);
    expect(last.x + last.width, 'folga à direita').toBeLessThanOrEqual(
      strip.x + strip.width - 8 + 1,
    );
    expect(
      await page.locator('ul.shortcuts').evaluate((el) => el.scrollWidth <= el.clientWidth),
      'a faixa não rola',
    ).toBe(true);
    // Mesma altura e mesma largura do azulejo de um atalho: o palco não sobe nem desce.
    for (const box of [first, last]) {
      expect(Math.abs(box.height - tile.height), 'altura').toBeLessThanOrEqual(1);
      expect(Math.abs(box.width - tile.width), 'largura').toBeLessThanOrEqual(1);
    }
    expect((await page.locator('.viewport').boundingBox())!.y, 'o palco não salta').toBeCloseTo(
      stageTop,
      0,
    );
    await expect(page.getByText(/sem atalhos/i)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectNoVerticalScroll(page);
  });

  test('a fileira vazia já na abertura mostra as sugestões ao dono, sem presumir app instalado', async ({
    page,
  }) => {
    tv.shortcuts = [];
    await openTv(page);
    await expect(page.locator('.shortcuts .shortcut.suggestion').first()).toBeVisible();
    await expect(page.locator('.shortcuts .shortcut:not(.suggestion)')).toHaveCount(0);
    await expect(page.getByText('Fixe apps aqui: abra o menu, no topo.')).toHaveCount(0);
    // Tocar numa sugestão só abre o painel dela: nada vai à TV nem à lista de atalhos.
    await page.getByRole('button', { name: 'Sugestão: Netflix', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Netflix' })).toBeVisible();
    expect(tv.requests.filter((r) => r.method !== 'GET' && r.path !== '/wake')).toEqual([]);
    await expectNoVerticalScroll(page);
  });

  test('muitos atalhos rolam na faixa, todos do mesmo tamanho, sem rolagem da tela', async ({
    page,
  }) => {
    tv.shortcuts = Array.from({ length: 9 }, (_, index) => ({
      id: `00000000-0000-4000-8000-0000000000${String(index + 10)}`,
      position: index + 1,
      package: `exemplo.pacote.app${index + 1}`,
      tvLabel: null,
      customLabel: `Aplicativo número ${index + 1}`,
      enabled: true,
      installed: true,
    }));
    await openTv(page);
    const strip = page.locator('.shortcuts');
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await strip.evaluate((el) => getComputedStyle(el).scrollSnapType)).toContain('x');
    await strip.evaluate((el) => el.scrollTo({ left: 400 }));
    await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
    await expectSameSquares(page.locator('.shortcuts .shortcut'));
    await expectNoHorizontalScroll(page);
    await expectNoVerticalScroll(page);
  });
});

test.describe('controle: as três páginas do palco central', () => {
  test('direções com o OK, números e touchpad (nesta ordem), com três pontos que acompanham', async ({
    page,
  }, info) => {
    await openTv(page);
    await expect(dot(page, 1)).toHaveAttribute('aria-current', 'true');
    await expect(button(page, 'OK')).toBeInViewport({ ratio: 1 });

    await dot(page, 2).click();
    await settlePage(page, 1);
    await expect(dot(page, 2)).toHaveAttribute('aria-current', 'true');
    await expect(button(numbersPage(page), 'Número 5')).toBeInViewport({ ratio: 1 });
    await expectNoHorizontalScroll(page);
    await expectNoVerticalScroll(page);
    await screenshot(page, `test-results/tv-numbers-${info.project.name}.png`);
    await expectNoSeriousViolations(page);

    for (const digit of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      await expectTargetSize(button(numbersPage(page), `Número ${digit}`));
      const before = tv.keysSent().length;
      await button(numbersPage(page), `Número ${digit}`).click();
      await expect.poll(() => tv.keysSent().slice(before)).toEqual([`NUM_${digit}`]);
    }
    await expectTargetSize(button(numbersPage(page), 'Origem'));
    const before = tv.keysSent().length;
    await button(numbersPage(page), 'Origem').click();
    await expect.poll(() => tv.keysSent().slice(before)).toEqual(['INPUT']);

    await dot(page, 3).click();
    await settlePage(page, 2);
    await expect(dot(page, 3)).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('app-touchpad-surface .pad')).toBeInViewport({ ratio: 1 });
    await expect(page.getByText('Deslize para mover · toque para OK')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoVerticalScroll(page);
    await screenshot(page, `test-results/tv-touchpad-${info.project.name}.png`);
    await expectNoSeriousViolations(page);

    await dot(page, 1).click();
    await settlePage(page, 0);
    await expect(dot(page, 1)).toHaveAttribute('aria-current', 'true');
    await expect(button(page, 'OK')).toBeInViewport({ ratio: 1 });
  });

  test('não há mais o modo "Botões | Touchpad": nem o botão quadrado, nem os chips', async ({
    page,
  }) => {
    await openTv(page);
    await expect(page.getByRole('button', { name: 'Trocar para o modo touchpad' })).toHaveCount(0);
    await expect(button(page, 'Botões')).toHaveCount(0);
    await expect(button(page, 'Touchpad')).toHaveCount(0);
  });

  test('rolar o carrossel marca o ponto da página à vista', async ({ page }) => {
    await openTv(page);
    await page.locator('.pager').evaluate((el) => el.scrollTo({ left: el.clientWidth }));
    await expect(dot(page, 2)).toHaveAttribute('aria-current', 'true');
    await page.locator('.pager').evaluate((el) => el.scrollTo({ left: 2 * el.clientWidth }));
    await expect(dot(page, 3)).toHaveAttribute('aria-current', 'true');
    await expectNoHorizontalScroll(page);
  });

  test('as setas do teclado nos pontos trocam a página sem gesto, pelas três', async ({ page }) => {
    await openTv(page);
    await dot(page, 1).focus();
    await page.keyboard.press('ArrowRight');
    await settlePage(page, 1);
    await expect(dot(page, 2)).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('ArrowRight');
    await settlePage(page, 2);
    await expect(dot(page, 3)).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('ArrowLeft');
    await settlePage(page, 1);
    await expect(dot(page, 2)).toHaveAttribute('aria-current', 'true');
  });

  test('o palco é focável e as setas do teclado rolam entre as páginas', async ({ page }) => {
    await openTv(page);
    const pager = page.getByRole('group', { name: 'Direções, números e touchpad' });
    await pager.focus();
    await expect(pager).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await settlePage(page, 1);
    await expect(dot(page, 2)).toHaveAttribute('aria-current', 'true');
  });

  test('só o palco troca de página: atalhos, Apps, pílulas, botões redondos e pontos não saem do lugar', async ({
    page,
  }, info) => {
    await openTv(page);
    const before = await fixedBoxes(page);
    await dot(page, 2).click();
    await settlePage(page, 1);
    await screenshot(page, `test-results/tv-stage-numbers-${info.project.name}.png`);
    expect(await fixedBoxes(page)).toEqual(before);
    // Só o palco mudou de conteúdo: os números aparecem onde estava o anel.
    await expect(button(numbersPage(page), 'Número 1')).toBeInViewport({ ratio: 1 });
    await expect(button(page, 'OK')).not.toBeInViewport();
    await dot(page, 3).click();
    await settlePage(page, 2);
    expect(await fixedBoxes(page)).toEqual(before);
    await dot(page, 1).click();
    await settlePage(page, 0);
    expect(await fixedBoxes(page)).toEqual(before);
    await expect(button(page, 'OK')).toBeInViewport({ ratio: 1 });
  });

  test('deslizar com o dedo sobre um botão vira a página e não aperta tecla', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'o gesto de toque sintético só existe no Chromium');
    await openTv(page);
    const ok = (await button(page, 'OK').boundingBox())!;
    await swipe(page, { x: ok.x + ok.width / 2, y: ok.y + ok.height / 2 }, -250);
    await expect(dot(page, 2)).toHaveAttribute('aria-current', 'true');
    expect(tv.keysSent()).toEqual([]);
  });

  test('deslizar com o dedo sobre os botões de baixo não vira a página nem aperta tecla', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'o gesto de toque sintético só existe no Chromium');
    await openTv(page);
    const menu = (await button(page, 'Menu').boundingBox())!;
    await swipe(page, { x: menu.x + menu.width / 2, y: menu.y + menu.height / 2 }, -200);
    await page.waitForTimeout(400);
    await expect(dot(page, 1)).toHaveAttribute('aria-current', 'true');
    expect(tv.keysSent()).toEqual([]);
  });

  test('no touchpad, deslizar a partir da margem esquerda volta aos números; dentro dele manda setas', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'o gesto de toque sintético só existe no Chromium');
    await openTv(page);
    await dot(page, 3).click();
    await settlePage(page, 2);
    const pager = (await page.locator('.pager').boundingBox())!;
    const pad = (await page.locator('app-touchpad-surface .pad').boundingBox())!;
    expect(pad.x - pager.x, 'margem do touchpad').toBeGreaterThanOrEqual(12);
    // Começando na margem (fora do touchpad), o deslize vira a página e não manda tecla.
    await swipe(page, { x: pager.x + 6, y: pad.y + pad.height / 2 }, 250);
    await expect(dot(page, 2)).toHaveAttribute('aria-current', 'true');
    expect(tv.keysSent()).toEqual([]);
  });

  test('touchpad: deslizar manda setas, toque curto manda OK, toque longo não manda nada', async ({
    page,
  }) => {
    await openTv(page);
    await dot(page, 3).click();
    await settlePage(page, 2);
    const pad = page.locator('app-touchpad-surface .pad');
    await expect(pad).toBeVisible();
    // O touchpad tem rótulo e instrução para leitor de tela (o anel e os botões seguem como alternativa).
    await expect(page.getByRole('group', { name: /^Touchpad: deslize/ })).toHaveCount(1);

    const box = (await pad.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Deslizar para a direita: seta, nunca OK.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 50, cy, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => tv.keysSent()).toContain('RIGHT');
    expect(tv.keysSent()).not.toContain('OK');

    // Toque curto e parado: OK.
    const before = tv.keysSent().length;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => tv.keysSent().slice(before)).toEqual(['OK']);

    // Toque longo (acima de 200 ms) não aperta OK sem querer.
    const afterTap = tv.keysSent().length;
    await page.mouse.down();
    await page.waitForTimeout(450);
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(tv.keysSent().length).toBe(afterTap);

    // Voltar, início e volume continuam à mão, e o anel volta pelo ponto 1.
    const row = tv.keysSent().length;
    await button(page, 'Voltar').click();
    await button(page, 'Aumentar o volume').click();
    await expect.poll(() => tv.keysSent().slice(row)).toEqual(['BACK', 'VOLUME_UP']);

    await dot(page, 1).click();
    await settlePage(page, 0);
    await expect(page.getByRole('group', { name: 'Setas de direção' })).toBeVisible();
    await expect(button(page, 'OK')).toBeInViewport({ ratio: 1 });
  });
});

test.describe('ponto de estado clicável', () => {
  test('é um botão de 44 px ao lado do título, fora do h1', async ({ page }) => {
    await openTv(page);
    const trigger = statusDot(page, 'Conectada');
    await expectTargetSize(trigger);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('TV');
    await expect(page.locator('h1 app-status-indicator')).toHaveCount(0);
  });

  test('cada fase tem cor e forma próprias, e a forma não depende só da cor', async ({
    page,
    context,
  }, info) => {
    await openTv(page);
    const shapes = new Map<string, string>();
    const colors = new Map<string, string>();
    const check = async (title: string, phase: string) => {
      const trigger = statusDot(page, title);
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveAttribute('data-phase', phase);
      const svg = trigger.locator('svg');
      shapes.set(phase, await svg.innerHTML());
      colors.set(phase, await svg.evaluate((el) => getComputedStyle(el).color));
      await screenshot(page, `test-results/tv-status-${phase}-${info.project.name}.png`);
    };

    await check('Conectada', 'connected');
    await sendState(page, { connection: 'hibernating' });
    await check('Dormindo', 'sleeping');
    await sendState(page, { agentOnline: false, connection: 'disconnected', volume: null });
    await check('Agente desligado', 'agent-off');
    await sendState(page, {});
    await emitSse(page, 'tv.watchdog', {
      kind: 'repair_failed',
      severity: 'error',
      detail: '',
      attempts: 3,
      at: '2026-10-19T14:02:00Z',
    });
    await check('Atenção', 'attention');
    await context.setOffline(true);
    await check('Sem rede', 'offline');

    expect(shapes.size).toBe(5);
    expect(new Set(shapes.values()).size, 'uma forma diferente por fase').toBe(5);
    // Conectada, dormindo, agente desligado e vermelho (atenção e sem rede) são tons diferentes.
    expect(new Set(colors.values()).size, 'tons por fase').toBeGreaterThanOrEqual(4);
  });

  test('"conectando" pulsa só para quem não pediu menos movimento', async ({ page }) => {
    let release!: () => void;
    tv.stateGate = new Promise<void>((resolve) => (release = resolve));
    await signIn(page);
    await page.goto('/tv');
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    const trigger = statusDot(page, 'Conectando');
    await expect(trigger).toHaveAttribute('data-phase', 'connecting');
    const pulse = trigger.locator('.pulse');
    const animation = () => pulse.evaluate((el) => getComputedStyle(el).animationName);
    expect(await animation()).not.toBe('none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(animation).toBe('none');

    release();
    await emitSse(page, 'tv.state', tv.state);
    await expect(statusDot(page, 'Conectada')).toBeVisible();
  });

  test('tocar abre o painelzinho com nome, frase e hora; Esc fecha e devolve o foco ao ponto', async ({
    page,
  }, info) => {
    await openTv(page);
    await statusDot(page).click();
    const panel = statusPanel(page);
    await expect(panel).toBeVisible();
    await expect(statusDot(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.locator('strong')).toHaveText('Conectada');
    await expect(panel).toContainText('Depois de 5 min sem uso ele dorme sozinho');
    await expect(panel).toContainText(/Atualizado às \d{2}:\d{2}/);
    await expect(panel.getByRole('button')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectNoVerticalScroll(page);
    await screenshot(page, `test-results/tv-status-panel-${info.project.name}.png`);
    await expectNoSeriousViolations(page);

    // O painelzinho cabe na largura da tela.
    const box = (await panel.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);

    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(statusDot(page)).toBeFocused();

    // Tocar de novo abre, e um toque fora fecha.
    await statusDot(page).click();
    await expect(panel).toBeVisible();
    await page.mouse.click(viewport.width / 2, viewport.height - 12);
    await expect(panel).toHaveCount(0);
  });

  test('dormindo: oferece "Acordar o controle", que pede o aquecimento e fecha o painel', async ({
    page,
  }) => {
    await openTv(page);
    await sendState(page, { connection: 'hibernating' });
    await expect(statusDot(page, 'Dormindo')).toBeVisible();
    // O primeiro comando reconecta: dormindo, os botões seguem valendo.
    await expect(button(page, 'OK')).toBeEnabled();

    await statusDot(page).click();
    const panel = statusPanel(page);
    await expect(panel).toContainText(/Só o controle está dormindo/);
    await expect(page.getByText(/TV desligada/i)).toHaveCount(0);
    await expect(page.getByText('hiberna em')).toHaveCount(0);
    await expectNoSeriousViolations(page);

    const before = tv.count('/wake');
    await panel.getByRole('button', { name: 'Acordar o controle' }).click();
    await expect.poll(() => tv.count('/wake')).toBe(before + 1);
    await expect(panel).toHaveCount(0);
    await expect(statusDot(page)).toBeFocused();
  });

  test('sem o agente: "Tentar de novo" lê o estado de novo e libera os botões quando ele volta', async ({
    page,
  }, info) => {
    await openTv(page);
    tv.state = { ...HOT_STATE, agentOnline: false, connection: 'disconnected', volume: null };
    await emitSse(page, 'tv.state', tv.state);
    await expect(statusDot(page, 'Agente desligado')).toBeVisible();
    await expect(
      page.getByText('O agente da TV está desligado, então os botões não funcionam agora.'),
    ).toBeVisible();
    await expect(button(page, 'OK')).toBeDisabled();
    await expect(button(page, 'Desligar a TV')).toBeDisabled();
    await expect(page.getByRole('img', { name: 'Volume desconhecido' })).toBeVisible();
    await expect(page.getByText(/TV desligada/i)).toHaveCount(0);
    await screenshot(page, `test-results/tv-agent-off-${info.project.name}.png`);
    await expectNoVerticalScroll(page);
    await expectNoSeriousViolations(page);

    const states = () =>
      tv.requests.filter((r) => r.method === 'GET' && r.path === '/state').length;
    const wakes = tv.count('/wake');

    // Ainda sem agente: lê de novo, segue desligado e não pede aquecimento (não há para quem pedir).
    await statusDot(page).click();
    const before = states();
    await statusPanel(page).getByRole('button', { name: 'Tentar de novo' }).click();
    await expect.poll(states).toBeGreaterThan(before);
    await expect(statusDot(page, 'Agente desligado')).toBeVisible();
    expect(tv.count('/wake')).toBe(wakes);

    // O agente volta: a próxima leitura traz o estado e tudo se reabilita.
    tv.state = { ...HOT_STATE };
    await statusDot(page).click();
    await statusPanel(page).getByRole('button', { name: 'Tentar de novo' }).click();
    await expect(statusDot(page, 'Conectada')).toBeVisible();
    await expect(button(page, 'OK')).toBeEnabled();
  });

  test('o vigia que religou o serviço, o reparo que falhou e o "reconectando" ficam no painelzinho', async ({
    page,
  }) => {
    await openTv(page);
    await emitSse(page, 'tv.watchdog', {
      kind: 'repaired',
      severity: 'info',
      detail: '',
      attempts: 1,
      at: '2026-10-19T14:02:00Z',
    });
    await statusDot(page).click();
    await expect(statusPanel(page)).toContainText(/controle religado às \d{2}:\d{2}/);
    await page.keyboard.press('Escape');

    await emitSse(page, 'tv.watchdog', {
      kind: 'repair_failed',
      severity: 'error',
      detail: '',
      attempts: 3,
      at: '2026-10-19T14:05:00Z',
    });
    await expect(statusDot(page, 'Atenção')).toBeVisible();
    await statusDot(page).click();
    await expect(statusPanel(page)).toContainText(/reparo do controle falhou às \d{2}:\d{2}/);
    await page.keyboard.press('Escape');

    await failSse(page);
    await statusDot(page).click();
    await expect(statusPanel(page)).toContainText('Reconectando ao servidor…');
    await expect.poll(() => sseUrls(page)).toHaveLength(2);
    await expect(statusPanel(page)).not.toContainText('Reconectando ao servidor…');
  });

  test('sem rede, mostra o último estado com a hora e desabilita os botões', async ({
    page,
    context,
  }, info) => {
    await openTv(page);
    await context.setOffline(true);
    await expect(statusDot(page, 'Sem rede')).toBeVisible();
    await expect(page.getByText(/Sem rede: o controle precisa de internet/)).toBeVisible();
    await expect(button(page, 'OK')).toBeDisabled();
    await expect(button(page, 'Desligar a TV')).toBeDisabled();
    await statusDot(page).click();
    await expect(statusPanel(page)).toContainText(/Visto às \d{2}:\d{2} · conectada/);
    // A faixa "Sem conexão" da casca soma a própria altura à do documento, em qualquer tela: a rolagem vertical
    // só é conferida com rede.
    await screenshot(page, `test-results/tv-offline-${info.project.name}.png`);

    await context.setOffline(false);
    await expect(button(page, 'OK')).toBeEnabled();
    await expect(statusDot(page, 'Sem rede')).toHaveCount(0);
  });

  test('sem agente configurado o ponto pede atenção e o controle dá lugar ao estado vazio', async ({
    page,
  }) => {
    // Sem agente configurado a API informa agente fora do ar, e o aquecer volta 503 com o tipo próprio.
    tv.state = { ...HOT_STATE, agentOnline: false, connection: 'disconnected', volume: null };
    tv.wakeFailure = { status: 503, kind: 'agent-not-configured' };
    await signIn(page);
    await page.goto('/tv');
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await emitSse(page, 'tv.state', tv.state);
    await emitSse(page, 'tv.shortcuts', tv.shortcuts);
    await expect(statusDot(page, 'Sem agente configurado')).toHaveAttribute(
      'data-phase',
      'attention',
    );
    // Nenhum botão de comando chegaria a lugar nenhum: no lugar deles, uma ação só (o detalhe está em tv-menu.spec.ts).
    await expect(
      page.getByRole('heading', { level: 2, name: 'Nenhuma TV configurada' }),
    ).toBeVisible();
    await expect(button(page, 'OK')).toHaveCount(0);
  });

  test('o foco do teclado é visível no ponto de estado', async ({ page }) => {
    await openTv(page);
    await statusDot(page).focus();
    const outline = await statusDot(page).evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe('solid');
  });
});

test.describe('estado ao vivo', () => {
  test('o fluxo abre sem token na URL, pede aquecer e reflete os eventos', async ({ page }) => {
    await openTv(page);
    const urls = await sseUrls(page);
    expect(urls).toEqual(['/api/v1/tv/events']);
    expect(urls.join('')).not.toMatch(/token/i);
    expect(identity.requests.some((r) => r.path === '/auth/stream-ticket')).toBe(true);
    await expect.poll(() => tv.count('/wake')).toBeGreaterThanOrEqual(1);
    await expect.poll(() => tv.requests.some((r) => r.path === '/state')).toBe(true);
  });
});

test.describe('erros de comando', () => {
  test('504 diz que a TV não respondeu, sem repetir o pedido', async ({ page }) => {
    await openTv(page);
    tv.commandFailure = { status: 504, kind: 'agent-timeout' };
    await button(page, 'OK').click();
    await expect(page.getByRole('alert')).toHaveText('A TV não respondeu a tempo. Tente de novo.');
    await page.waitForTimeout(600);
    expect(tv.keysSent()).toEqual(['OK']);
  });

  test('503 do agente mostra "agente desligado" e trava os botões', async ({ page }) => {
    await openTv(page);
    tv.commandFailure = { status: 503, kind: 'agent-offline' };
    await button(page, 'OK').click();
    await expect(page.getByRole('alert')).toContainText('O agente da TV está desligado');
    await expect(statusDot(page, 'Agente desligado')).toBeVisible();
    await expect(button(page, 'OK')).toBeDisabled();
    expect(tv.keysSent()).toEqual(['OK']);
  });

  test('502 traz a causa do agente e 429 traz o tempo de espera', async ({ page }) => {
    await openTv(page);
    tv.commandFailure = {
      status: 502,
      kind: 'command-failed',
      extra: { agentError: 'TV_UNREACHABLE' },
    };
    await button(page, 'Menu').click();
    await expect(page.getByRole('alert')).toContainText('A TV não respondeu ao controle');

    tv.commandFailure = {
      status: 429,
      kind: 'rate-limited',
      headers: { 'retry-after': '7' },
    };
    await button(page, 'Menu').click();
    await expect(page.getByRole('alert')).toHaveText(
      'Comandos demais em pouco tempo. Aguarde 7 s.',
    );
    expect(tv.keysSent()).toEqual(['MENU', 'MENU']);
  });

  test('o aviso passageiro não segura o toque nos botões de baixo', async ({ page }) => {
    await openTv(page);
    tv.commandFailure = { status: 504, kind: 'agent-timeout' };
    await button(page, 'OK').click();
    await expect(page.getByRole('alert')).toBeVisible();
    tv.commandFailure = null;
    // O aviso cobre a fileira de baixo, mas deixa o toque passar.
    await button(page, 'Menu').click();
    await expect.poll(() => tv.keysSent()).toEqual(['OK', 'MENU']);
  });
});

test.describe('desligar', () => {
  test('a folha confirma e o pedido sai uma vez, sem passkey', async ({ page }, info) => {
    await openTv(page);
    await button(page, 'Desligar a TV').click();
    const sheet = page.getByRole('dialog', { name: 'Desligar a TV?' });
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByText('Sem o emissor infravermelho, a TV só volta com o controle original.'),
    ).toBeVisible();
    await expect(sheet.getByRole('button', { name: /fechar|close/i })).toHaveCount(0);
    await expect(sheet.getByRole('button')).toHaveText(['Cancelar', 'Desligar']);
    await page.waitForTimeout(300); // fim da animação de subida
    await screenshot(page, `test-results/tv-power-sheet-${info.project.name}.png`);
    await expectNoSeriousViolations(page);

    // Cancelar não manda nada.
    await sheet.getByRole('button', { name: 'Cancelar' }).click();
    await expect(sheet).toHaveCount(0);
    expect(tv.count('/power/off')).toBe(0);

    // Esc também cancela.
    await button(page, 'Desligar a TV').click();
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    expect(tv.count('/power/off')).toBe(0);

    await button(page, 'Desligar a TV').click();
    await sheet.getByRole('button', { name: 'Desligar', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(
      page.getByText('Pedido de desligar enviado. A TV só volta com o controle original.'),
    ).toBeVisible();
    expect(tv.count('/power/off')).toBe(1);
    expect(tv.keysSent()).not.toContain('POWER');
    expect(identity.requests.some((r) => r.path.startsWith('/step-up'))).toBe(false);
    await expect(page.getByRole('dialog', { name: 'Confirmar com passkey' })).toHaveCount(0);
  });

  test('se a TV não responde, o motivo aparece dentro da folha e ela continua aberta', async ({
    page,
  }) => {
    await openTv(page);
    tv.commandFailure = { status: 504, kind: 'agent-timeout' };
    await button(page, 'Desligar a TV').click();
    const sheet = page.getByRole('dialog', { name: 'Desligar a TV?' });
    await sheet.getByRole('button', { name: 'Desligar', exact: true }).click();
    await expect(sheet.getByRole('alert')).toHaveText('A TV não respondeu a tempo. Tente de novo.');
    await expect(sheet).toBeVisible();
    expect(tv.count('/power/off')).toBe(1);
  });
});

test.describe('desligar com leitura', () => {
  /** A única TV da conta, cujo agente declara o desligamento com leitura (o servidor manda as capacidades). */
  const SAFE_TV = {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Sala',
    isDefault: true,
    agentSlug: 'pc-sala',
    kind: 'android' as const,
    online: true,
    capabilities: ['tv.remote', 'tv.kind.android', 'tv.power.off.v1', 'tv.key.v3'],
  };
  const sheetOf = (page: Page) => page.getByRole('dialog', { name: 'Desligar a TV?' });
  const turnOff = async (page: Page) => {
    await button(page, 'Desligar a TV').click();
    await sheetOf(page).getByRole('button', { name: 'Desligar', exact: true }).click();
  };

  test('o agente que declara a capacidade recebe o pedido explícito, e a tela diz que desligou', async ({
    page,
  }, info) => {
    tv.tvs = [{ ...SAFE_TV }];
    await openTv(page);
    await button(page, 'Desligar a TV').click();
    await expect(sheetOf(page)).toContainText('O agente só desliga se a TV estiver ligada');
    await page.waitForTimeout(300); // fim da animação de subida
    await screenshot(page, `test-results/tv-power-checked-${info.project.name}.png`);
    await expectNoSeriousViolations(page);
    await sheetOf(page).getByRole('button', { name: 'Desligar', exact: true }).click();
    await expect(sheetOf(page)).toHaveCount(0);
    await expect(
      page.getByText('TV desligada. Ela só volta com o controle original.'),
    ).toBeVisible();
    expect(tv.powerOffModes()).toEqual(['safe']);
    expect(tv.keysSent()).not.toContain('POWER');
  });

  test('a TV que já estava desligada não é erro: o aviso diz que nada foi enviado', async ({
    page,
  }) => {
    tv.tvs = [{ ...SAFE_TV }];
    tv.powerOffOutcome = 'already_off';
    await openTv(page);
    await turnOff(page);
    await expect(sheetOf(page)).toHaveCount(0);
    await expect(
      page.getByText('A TV já estava desligada. Nenhuma tecla foi enviada.'),
    ).toBeVisible();
  });

  test('sem confirmação do agente a folha continua aberta e diz que a tecla não foi repetida', async ({
    page,
  }) => {
    tv.tvs = [{ ...SAFE_TV }];
    tv.commandFailure = {
      status: 502,
      kind: 'command-failed',
      extra: { agentError: 'uncertain' },
    };
    await openTv(page);
    await turnOff(page);
    await expect(sheetOf(page).getByRole('alert')).toHaveText(
      'Não deu para confirmar se a TV desligou, e a tecla não foi repetida. Olhe a TV antes de tentar de novo.',
    );
    await expect(sheetOf(page)).toBeVisible();
    expect(tv.powerOffModes()).toEqual(['safe']);
  });

  test('agente sem a capacidade segue com o pedido de antes, sem corpo', async ({ page }) => {
    tv.tvs = [{ ...SAFE_TV, capabilities: ['tv.remote', 'tv.kind.android', 'tv.key.v3'] }];
    await openTv(page);
    await button(page, 'Desligar a TV').click();
    await expect(sheetOf(page)).not.toContainText('O agente só desliga se a TV estiver ligada');
    await sheetOf(page).getByRole('button', { name: 'Desligar', exact: true }).click();
    await expect(
      page.getByText('Pedido de desligar enviado. A TV só volta com o controle original.'),
    ).toBeVisible();
    expect(tv.powerOffModes()).toEqual([null]);
  });
});

test.describe('limpar a TV', () => {
  const cleanButton = (page: Page) => appsDialog(page).locator('button.clean');
  const cleanSheet = (page: Page) => page.getByRole('dialog', { name: 'Limpar a TV?' });
  const notice = (page: Page) => appsDialog(page).locator('.notice');

  test('a folha confirma, o pedido sai uma vez e o resultado volta como aviso no painel', async ({
    page,
  }, info) => {
    await openTv(page);
    await openApps(page);
    await expect(cleanButton(page)).toHaveAccessibleName('Limpar a TV');
    await expectTargetSize(cleanButton(page));
    await settleMotion(page);

    await cleanButton(page).click();
    const sheet = cleanSheet(page);
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByText(
        'Isso fecha todos os apps abertos, inclusive o que está passando agora, e libera memória. A conexão com o controle continua.',
      ),
    ).toBeVisible();
    await expect(sheet.getByRole('button', { name: /fechar|close/i })).toHaveCount(0);
    await expect(sheet.getByRole('button')).toHaveText(['Cancelar', 'Limpar']);
    await page.waitForTimeout(300); // fim da animação de subida
    await expectNoHorizontalScroll(page);
    await expectNoSeriousViolations(page);
    await screenshot(page, `test-results/tv-cleanup-sheet-${info.project.name}.png`);

    // Cancelar e Esc não mandam nada, e o foco volta ao botão.
    await sheet.getByRole('button', { name: 'Cancelar' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(cleanButton(page)).toBeFocused();
    await cleanButton(page).click();
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    expect(tv.count('/cleanup')).toBe(0);

    await cleanButton(page).click();
    await sheet.getByRole('button', { name: 'Limpar', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => tv.count('/cleanup')).toBe(1);
    await expect(notice(page)).toHaveText('Fechou 6 apps e liberou cerca de 380 MB.');
    await expect(notice(page)).toHaveAttribute('role', 'status');
    await expect(appsDialog(page)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await screenshot(page, `test-results/tv-cleanup-result-${info.project.name}.png`);
    expect(tv.keysSent()).toEqual([]);
  });

  test('enquanto limpa mostra "Limpando…", segue um pedido por vez e o resto do controle funciona', async ({
    page,
  }, info) => {
    let release!: () => void;
    tv.cleanupGate = new Promise<void>((resolve) => (release = resolve));
    await openTv(page);
    await openApps(page);
    await settleMotion(page);
    await cleanButton(page).click();
    await cleanSheet(page).getByRole('button', { name: 'Limpar', exact: true }).click();
    await expect(cleanSheet(page)).toHaveCount(0);

    await expect(cleanButton(page)).toHaveAccessibleName('Limpando a TV…');
    await expect(cleanButton(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(
      appsDialog(page).getByText('Limpando a TV… pode levar até meio minuto.'),
    ).toBeVisible();
    await screenshot(page, `test-results/tv-cleanup-running-${info.project.name}.png`);

    // Um segundo toque não abre a folha nem manda outro pedido (o Playwright trata aria-disabled como desabilitado e
    // esperaria para sempre: o toque é forçado).
    await cleanButton(page).click({ force: true });
    await expect(cleanSheet(page)).toHaveCount(0);
    expect(tv.count('/cleanup')).toBe(1);

    // O controle de trás segue: fecha o painel e manda uma tecla com a limpeza ainda esperando.
    await page.keyboard.press('Escape');
    await expect(appsDialog(page)).toHaveCount(0);
    await button(page, 'Aumentar o volume').click();
    await expect.poll(() => tv.keysSent()).toContain('VOLUME_UP');

    release();
    await expect(page.getByText('Fechou 6 apps e liberou cerca de 380 MB.')).toBeVisible();
    expect(tv.count('/cleanup')).toBe(1);
  });

  test('o resultado só diz o que foi medido: sem memória, só os apps; sem nada, "Nada para fechar."', async ({
    page,
  }) => {
    await openTv(page);
    await openApps(page);
    tv.cleanupResult = { ...tv.cleanupResult, closedApps: 1, freedMb: null };
    await cleanButton(page).click();
    await cleanSheet(page).getByRole('button', { name: 'Limpar', exact: true }).click();
    await expect(notice(page)).toHaveText('Fechou 1 app.');

    tv.cleanupResult = { ...tv.cleanupResult, closedApps: 0, freedMb: 2, failedSteps: [] };
    await cleanButton(page).click();
    await cleanSheet(page).getByRole('button', { name: 'Limpar', exact: true }).click();
    await expect(notice(page)).toHaveText('Nada para fechar.');
    expect(tv.count('/cleanup')).toBe(2);
  });

  test('cada erro tem a sua mensagem, uma vez só e sem repetir o pedido', async ({ page }) => {
    await openTv(page);
    await openApps(page);
    const clean = async () => {
      await cleanButton(page).click();
      await cleanSheet(page).getByRole('button', { name: 'Limpar', exact: true }).click();
    };

    tv.commandFailure = {
      status: 502,
      kind: 'command-failed',
      extra: { agentError: 'adb_unreachable' },
    };
    await clean();
    await expect(appsDialog(page).getByRole('alert')).toHaveText(
      'A TV não respondeu pelo ADB agora. Tente de novo com a TV ligada.',
    );

    tv.commandFailure = { status: 504, kind: 'agent-timeout' };
    await clean();
    await expect(appsDialog(page).getByRole('alert')).toContainText(
      'A limpeza demorou mais do que o esperado',
    );

    tv.commandFailure = { status: 409, kind: 'cleanup-in-progress' };
    await clean();
    await expect(appsDialog(page).getByRole('alert')).toHaveText(
      'Já há uma limpeza da TV em andamento. Aguarde ela terminar.',
    );

    tv.commandFailure = { status: 429, kind: 'rate-limited', headers: { 'Retry-After': '5' } };
    await clean();
    await expect(appsDialog(page).getByRole('alert')).toHaveText(
      'Comandos demais em pouco tempo. Aguarde 5 s.',
    );
    expect(tv.count('/cleanup')).toBe(4);

    // Depois do erro dá para pedir de novo.
    tv.commandFailure = null;
    await clean();
    await expect(notice(page)).toHaveText('Fechou 6 apps e liberou cerca de 380 MB.');
    expect(tv.count('/cleanup')).toBe(5);
  });

  test('sem o agente o botão fica apagado mas focável, e o toque não abre nada nem pede nada', async ({
    page,
  }) => {
    await openTv(page);
    await sendState(page, { agentOnline: false, connection: 'disconnected', volume: null });
    await openApps(page);
    const clean = cleanButton(page);
    await expect(clean).toHaveAttribute('aria-disabled', 'true');
    // Apagado, não `disabled`: o atributo nativo segue ausente (o Playwright confunde os dois em toBeDisabled).
    expect(await clean.evaluate((el) => (el as HTMLButtonElement).disabled)).toBe(false);
    await expect(clean).toHaveCSS('opacity', '0.5');
    await clean.focus();
    await expect(clean).toBeFocused();
    await clean.click({ force: true });
    await expect(cleanSheet(page)).toHaveCount(0);
    expect(tv.count('/cleanup')).toBe(0);
  });
});

test.describe('painel flutuante: comportamento comum', () => {
  test('abre sobre o controle, que continua à vista, e fecha por Esc, toque fora, arrastar e botão', async ({
    page,
  }) => {
    await openTv(page);
    const viewport = page.viewportSize()!;

    // Esc.
    await openApps(page);
    await expect(appsDialog(page)).toHaveAttribute('aria-modal', 'true');
    await page.keyboard.press('Escape');
    await expect(appsDialog(page)).toHaveCount(0);

    // Toque fora do cartão (a margem de cima: o cartão fica embaixo).
    await openApps(page);
    await page.mouse.click(viewport.width / 2, 6);
    await expect(appsDialog(page)).toHaveCount(0);

    // Botão de fechar do cabeçalho.
    await openApps(page);
    await appsDialog(page).getByRole('button', { name: 'Fechar' }).click();
    await expect(appsDialog(page)).toHaveCount(0);

    // Arrastar o puxador para baixo.
    await openApps(page);
    await settleMotion(page);
    const grab = (await appsDialog(page).locator('.grab').boundingBox())!;
    const x = grab.x + grab.width / 2;
    const y = grab.y + 12;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 140, { steps: 8 });
    await page.mouse.up();
    await expect(appsDialog(page)).toHaveCount(0);
  });

  test('arrastar pouco e soltar não fecha: o cartão volta ao lugar', async ({ page }) => {
    await openTv(page);
    await openApps(page);
    await settleMotion(page);
    const card = appsDialog(page).locator('.card');
    const rest = (await card.boundingBox())!;
    const grab = (await appsDialog(page).locator('.grab').boundingBox())!;
    const x = grab.x + grab.width / 2;
    const y = grab.y + 12;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 30, { steps: 4 });
    await page.mouse.up();
    await expect(appsDialog(page)).toBeVisible();
    await expect.poll(async () => (await card.boundingBox())!.y).toBeCloseTo(rest.y, 0);
  });

  test('o foco entra no painel Apps e fica preso nele (o resto da tela fica inerte)', async ({
    page,
  }) => {
    await openTv(page);
    await openApps(page);
    await expect(appsDialog(page).locator(':focus')).toHaveCount(1);

    // Tab nunca chega a um controle de trás do painel.
    for (let step = 0; step < 14; step++) {
      await page.keyboard.press('Tab');
      const behind = await page.evaluate(
        () => document.activeElement?.closest('app-tv-control, header.head') ?? null,
      );
      expect(behind, `Tab ${step + 1}`).toBeNull();
    }
    await page.keyboard.press('Escape');
    await expect(appsDialog(page)).toHaveCount(0);
  });

  test('o painel Apps devolve o foco ao botão do cabeçalho que abriu o menu', async ({ page }) => {
    await openTv(page);
    const opener = button(page, 'Mais opções');
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(menuDialog(page)).toBeVisible();
    await menuDialog(page).getByRole('button', { name: 'Apps da TV' }).focus();
    await page.keyboard.press('Enter');
    await expect(appsDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(appsDialog(page)).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('o foco do Teclado entra no campo e volta ao botão que o abriu', async ({ page }) => {
    await openTv(page);
    const keyboard = button(page, 'Teclado');
    await keyboard.focus();
    await page.keyboard.press('Enter');
    await expect(keyboardDialog(page)).toBeVisible();
    await expect(keyboardField(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(keyboardDialog(page)).toHaveCount(0);
    await expect(keyboard).toBeFocused();
  });

  test('o painel sai por transição: a saída espera o fim dela antes de tirar o painel', async ({
    page,
  }) => {
    await openTv(page);
    await openApps(page);
    const card = appsDialog(page).locator('.card');
    expect(await card.evaluate((el) => getComputedStyle(el).transitionDuration)).not.toBe('0s');
    await settleMotion(page);
    expect(await card.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

    const started = Date.now();
    await page.keyboard.press('Escape');
    // Logo depois do pedido o painel ainda está na tela, saindo (a folha desce e o fundo esmaece).
    await expect(page.locator('dialog.panel.leaving')).toHaveCount(1);
    await expect(appsDialog(page)).toHaveCount(0);
    const elapsed = Date.now() - started;
    expect(elapsed, 'esperou a transição').toBeGreaterThanOrEqual(120);
    expect(elapsed, 'não ficou preso na saída').toBeLessThan(1500);
  });

  test('ao entrar, a folha parte transparente e termina opaca, com o fundo escurecido', async ({
    page,
  }) => {
    await openTv(page);
    const startingStyle = await page.evaluate(
      () =>
        typeof (window as unknown as { CSSStartingStyleRule?: unknown }).CSSStartingStyleRule !==
        'undefined',
    );
    test.skip(!startingStyle, 'este navegador não tem @starting-style: a folha só aparece');

    // O observador é armado ANTES de pedir o painel: a transição que sai do `@starting-style` (opacidade e deslocamento
    // do cartão, que parte de zero) dispara `transitionrun` assim que nasce, não importa em que quadro o teste olhe.
    // Amostrar a opacidade quadro a quadro depois do pedido perdia a janela num executor lento, e a primeira amostra
    // já vinha opaca.
    await page.evaluate(() => {
      const w = window as unknown as { __cardRuns: string[] };
      w.__cardRuns = [];
      document.addEventListener(
        'transitionrun',
        (event) => {
          const target = event.target as HTMLElement;
          if (target.classList?.contains('card') && target.closest('dialog.panel')) {
            w.__cardRuns.push(event.propertyName);
          }
        },
        true,
      );
      history.pushState(history.state, '', '/tv?painel=apps');
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    });
    await expect(appsDialog(page)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __cardRuns: string[] }).__cardRuns))
      .toEqual(expect.arrayContaining(['opacity', 'transform']));
    await expect
      .poll(() => page.locator('dialog.panel .card').evaluate((el) => getComputedStyle(el).opacity))
      .toBe('1');
    await settleMotion(page);
    expect(
      await page
        .locator('dialog.panel')
        .evaluate((el) => getComputedStyle(el, '::backdrop').backgroundColor),
    ).toMatch(/rgba?\(0, 0, 0, 0\.4\d*\)/);
  });

  test('a animação some para quem pediu menos movimento: sem transição, sem escalonado, e o painel sai na hora', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openTv(page);
    await openApps(page);
    const dialog = appsDialog(page);
    expect(
      await dialog.locator('.card').evaluate((el) => getComputedStyle(el).transitionDuration),
    ).toBe('0s');
    expect(
      await dialog
        .locator('.item')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe('none');
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog.panel.leaving')).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
  });

  test('sem pedir menos movimento os primeiros azulejos entram em escalonado curto, só os 12 primeiros', async ({
    page,
  }) => {
    tv.shortcuts = Array.from({ length: 30 }, (_, index) => ({
      id: `00000000-0000-4000-8000-00000000${String(2000 + index)}`,
      position: index + 1,
      package: `exemplo.pacote.app${index + 1}`,
      tvLabel: `Aplicativo ${index + 1}`,
      customLabel: null,
      enabled: true,
      installed: true,
    }));
    await openTv(page);
    await openApps(page);
    const items = appsDialog(page).locator('.item');
    await expect(items).toHaveCount(30);
    const delays = await items.evaluateAll((els) =>
      els.map((el) => {
        const style = getComputedStyle(el);
        return {
          name: style.animationName,
          delay: parseFloat(style.animationDelay),
        };
      }),
    );
    // O Angular acrescenta ao nome da animação o prefixo do componente (`ng-c123_tile-in`).
    expect(delays.filter((d) => d.name.endsWith('tile-in'))).toHaveLength(12);
    expect(delays.slice(12).every((d) => d.name === 'none')).toBe(true);
    // Escalonado crescente e curto: o último entra antes de meio segundo.
    const starts = delays.slice(0, 12).map((d) => d.delay);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(starts[11] + 0.2, 'fim do escalonado, em segundos').toBeLessThan(0.5);
    await settleMotion(page);
    expect(await items.first().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  });
});

test.describe('painel Apps', () => {
  test('lista os apps em azulejos, abre, edita (renomear e fixar) e atualiza a lista', async ({
    page,
  }, info) => {
    await openTv(page);
    await openApps(page);
    const dialog = appsDialog(page);
    await expect(dialog.getByRole('heading', { level: 2, name: 'Apps da TV' })).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 3, name: 'No controle' })).toBeVisible();
    await expect(dialog.locator('.item .name')).toHaveText(['Atalho 1', 'Atalho 2', 'Atalho 3']);
    // O pacote só aparece no modo Editar.
    await expect(dialog.locator('.package')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await settleMotion(page);
    await screenshot(page, `test-results/tv-apps-grid-${info.project.name}.png`);
    await expectNoSeriousViolations(page);

    // Editar: todos os apps numa lista só, com o pacote e os botões de fixar e renomear em cada azulejo.
    await button(dialog, 'Editar').click();
    await expect(dialog.getByRole('heading', { level: 3, name: 'Todos os apps' })).toBeVisible();
    await expect(dialog.locator('.item .package').first()).toHaveText('exemplo.pacote.app1');
    await expect(dialog.locator('.launch')).toHaveCount(0);
    await settleMotion(page);
    await screenshot(page, `test-results/tv-apps-edit-${info.project.name}.png`);
    await expectNoSeriousViolations(page);

    // Renomear: o foco vai para o campo e volta ao botão depois.
    await button(dialog, 'Renomear Atalho 2').click();
    await expect(dialog.getByLabel('Nome do atalho')).toBeFocused();
    await dialog.getByLabel('Nome do atalho').fill('Sala');
    await dialog.getByRole('button', { name: 'Salvar' }).click();
    await expect(dialog.locator('.item .name').nth(1)).toHaveText('Sala');
    await expect(button(dialog, 'Renomear Sala')).toBeFocused();
    expect(tv.requests.find((r) => r.method === 'PATCH')?.body).toEqual({
      customLabel: 'Sala',
      enabled: null,
    });

    // Tirar do controle: o azulejo fica onde está e o botão passa a oferecer "Fixar".
    await button(dialog, 'Tirar Atalho 3 do controle').click();
    await expect(button(dialog, 'Fixar Atalho 3 no controle')).toBeVisible();
    await expect(dialog.locator('.item .name')).toHaveText(['Atalho 1', 'Sala', 'Atalho 3']);

    // Concluir: volta às seções, e o que saiu do controle fica na de baixo, igual aos outros e podendo abrir.
    await button(dialog, 'Concluir').click();
    await expect(dialog.getByRole('heading', { level: 3, name: 'Fora do controle' })).toBeVisible();
    await expect(button(dialog, 'Atalho 3')).toBeEnabled();

    await button(dialog, 'Atualizar lista').click();
    await expect.poll(() => tv.count('/shortcuts/refresh')).toBe(1);
    // Com o painel aberto, o aviso aparece dentro dele (o aviso da tela ficaria atrás do fundo).
    await expect(dialog.getByText('Lista de apps atualizada.')).toBeVisible();

    // Abrir um app: o pedido sai, o painel fecha e o aviso aparece na tela do controle.
    await button(dialog, 'Atalho 1').click();
    await expect.poll(() => tv.count(`/shortcuts/${tv.shortcuts[0].id}/launch`)).toBe(1);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Atalho 1 aberto na TV.')).toBeVisible();

    // O atalho tirado do controle some da fileira de cima; o renomeado aparece com o nome novo.
    await expect(button(page, 'Atalho 1')).toBeVisible();
    await expect(button(page, 'Sala')).toBeVisible();
    await expect(button(page, 'Atalho 3')).toHaveCount(0);
  });

  /**
   * Cinco apps com nome: Alfa, Gama e Sigma estão no controle (a fileira de cima); Beta está fora dele; Delta saiu da
   * TV (o painel nem o mostra, mas a API o guarda e a ordem tem de levá-lo junto).
   */
  function orderShortcuts(): MockShortcut[] {
    const apps: [string, boolean, boolean][] = [
      ['Alfa', true, true],
      ['Beta', false, true],
      ['Gama', true, true],
      ['Delta', false, false],
      ['Sigma', true, true],
    ];
    return apps.map(([name, enabled, installed], index) => ({
      id: `00000000-0000-4000-8000-00000000${String(3000 + index)}`,
      position: index + 1,
      package: `exemplo.ordem.app${index + 1}`,
      tvLabel: name,
      customLabel: null,
      enabled,
      installed,
    }));
  }
  const putRequests = () => tv.requests.filter((r) => r.method === 'PUT');
  const orderStatus = (dialog: Locator) => dialog.locator('[data-reorder-status]');

  test('o dono muda a ordem dos atalhos: a fileira acompanha, o PUT leva a lista completa e recarregar mantém', async ({
    page,
  }, info) => {
    tv.shortcuts = orderShortcuts();
    const [alfa, beta, gama, delta, sigma] = tv.shortcuts.map((s) => s.id);
    await openTv(page);
    await expectChipNames(page, ['Alfa', 'Gama', 'Sigma']);
    await openApps(page);
    const dialog = appsDialog(page);
    await button(dialog, 'Editar').click();

    // Só quem está no controle tem as setas, e os dois botões são alvos de 44 px (medidos com a entrada dos azulejos parada).
    await expect(dialog.locator('[data-move]')).toHaveCount(6);
    await expect(dialog.getByRole('button', { name: /^Mover Beta / })).toHaveCount(0);
    await settleMotion(page);
    await expectTargetSize(button(dialog, 'Mover Gama para a esquerda'));
    await expectTargetSize(button(dialog, 'Mover Gama para a direita'));
    await expectNoHorizontalScroll(page);
    await screenshot(page, `test-results/tv-apps-reorder-${info.project.name}.png`);
    await expectNoSeriousViolations(page);

    await button(dialog, 'Mover Gama para a esquerda').click();

    // A fileira do controle, atrás do painel, já está na ordem nova.
    await expectChipNames(page, ['Gama', 'Alfa', 'Sigma']);
    // O foco fica no botão usado (que seguiu o app) e, na ponta, ele só fica apagado; quem ouve o leitor sabe onde o app ficou.
    const used = button(dialog, 'Mover Gama para a esquerda');
    await expect(used).toBeFocused();
    await expect(used).toHaveAttribute('aria-disabled', 'true');
    await expect(orderStatus(dialog)).toHaveText('Gama, posição 1 de 3');

    // O pedido leva a lista inteira (Beta e Delta incluídos) com Gama no lugar de Alfa; os outros não se mexem.
    await expect.poll(() => putRequests().length).toBe(1);
    expect(putRequests()[0]).toMatchObject({
      path: '/shortcuts/order',
      body: { ids: [gama, beta, alfa, delta, sigma] },
    });
    // O eco do servidor pelo fluxo não desfaz nada.
    await emitSse(page, 'tv.shortcuts', tv.shortcuts);
    await expectChipNames(page, ['Gama', 'Alfa', 'Sigma']);

    // Acionar de novo, pelo teclado, o botão apagado da ponta não pede nada ao servidor e não tira o foco dele.
    await used.focus();
    await page.keyboard.press('Enter');
    await expect(used).toBeFocused();
    expect(putRequests()).toHaveLength(1);

    // Outro passo: Sigma sobe uma casa.
    await button(dialog, 'Mover Sigma para a esquerda').click();
    await expectChipNames(page, ['Gama', 'Sigma', 'Alfa']);
    await expect(orderStatus(dialog)).toHaveText('Sigma, posição 2 de 3');
    await expect.poll(() => putRequests().length).toBe(2);
    expect(putRequests()[1].body).toEqual({ ids: [gama, beta, sigma, delta, alfa] });
    await expectNoHorizontalScroll(page);

    // Recarregar a tela mantém a ordem: ela vem do servidor, não da memória da página.
    await page.reload();
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await emitSse(page, 'tv.state', tv.state);
    await expectChipNames(page, ['Gama', 'Sigma', 'Alfa']);
  });

  test('a ordem muda na tela antes de o servidor responder, e o que ele devolve a confirma sem piscar', async ({
    page,
  }) => {
    tv.shortcuts = orderShortcuts();
    let release!: () => void;
    tv.orderGate = new Promise<void>((resolve) => (release = resolve));
    await openTv(page);
    await openApps(page);
    const dialog = appsDialog(page);
    await button(dialog, 'Editar').click();

    await button(dialog, 'Mover Sigma para a esquerda').click();
    await button(dialog, 'Mover Sigma para a esquerda').click();

    // O servidor ainda não respondeu e a fileira já mudou (duas vezes, num pedido só quando ele responder).
    await expectChipNames(page, ['Sigma', 'Alfa', 'Gama']);
    await expect(orderStatus(dialog)).toHaveText('Sigma, posição 1 de 3');
    expect(tv.shortcuts.map((s) => s.tvLabel)).toEqual(['Alfa', 'Beta', 'Gama', 'Delta', 'Sigma']);

    release();
    tv.orderGate = null;
    await expect
      .poll(() => tv.shortcuts.map((s) => s.tvLabel))
      .toEqual(['Sigma', 'Beta', 'Alfa', 'Delta', 'Gama']);
    await expectChipNames(page, ['Sigma', 'Alfa', 'Gama']);
    // Toques seguidos viram no máximo dois pedidos, e o último já tem a ordem final.
    expect(putRequests().length).toBeLessThanOrEqual(2);
    expect(putRequests().at(-1)?.body?.['ids']).toEqual(tv.shortcuts.map((s) => s.id));
  });

  test('se o servidor recusa a ordem, a fileira volta ao que era e o aviso diz que não foi salvo', async ({
    page,
  }) => {
    tv.shortcuts = orderShortcuts();
    tv.orderFailure = { status: 400, kind: 'validation-failed' };
    await openTv(page);
    await expectChipNames(page, ['Alfa', 'Gama', 'Sigma']);
    await openApps(page);
    const dialog = appsDialog(page);
    await button(dialog, 'Editar').click();

    await button(dialog, 'Mover Gama para a esquerda').click();

    await expect(
      dialog.getByText('Não foi possível salvar a nova ordem. Ela voltou ao que era.'),
    ).toBeVisible();
    await expectChipNames(page, ['Alfa', 'Gama', 'Sigma']);
    expect(tv.shortcuts.map((s) => s.tvLabel)).toEqual(['Alfa', 'Beta', 'Gama', 'Delta', 'Sigma']);
    // O que o leitor tinha ouvido ("posição 1") deixou de valer: o aviso de erro fala e a frase some.
    await expect(orderStatus(dialog)).toHaveText('');
    // O que o servidor tem continua valendo: tentar de novo depois funciona.
    tv.orderFailure = null;
    await button(dialog, 'Mover Gama para a esquerda').click();
    await expectChipNames(page, ['Gama', 'Alfa', 'Sigma']);
    await expect
      .poll(() => tv.shortcuts.map((s) => s.tvLabel))
      .toEqual(['Gama', 'Beta', 'Alfa', 'Delta', 'Sigma']);
  });

  test('a busca esconde as setas, porque o filtro esconderia os vizinhos', async ({ page }) => {
    tv.shortcuts = orderShortcuts();
    await openTv(page);
    await openApps(page);
    const dialog = appsDialog(page);
    await button(dialog, 'Editar').click();
    await expect(dialog.locator('[data-move]')).toHaveCount(6);

    await dialog.getByRole('searchbox', { name: 'Buscar app' }).fill('gama');
    await expect(dialog.locator('[data-move]')).toHaveCount(0);
    await dialog.getByRole('searchbox', { name: 'Buscar app' }).fill('');
    await expect(dialog.locator('[data-move]')).toHaveCount(6);
  });

  test('busca por texto numa lista só, com a marca de quem está no controle', async ({
    page,
  }, info) => {
    tv.shortcuts = tv.shortcuts.map((s) => ({
      ...s,
      customLabel: ['Câmera da sala', 'Filmes', 'Jogos'][s.position - 1],
      enabled: s.position !== 3,
    }));
    await openTv(page);
    await openApps(page);
    const dialog = appsDialog(page);
    const names = dialog.locator('.item .name');
    await expect(names).toHaveText(['Câmera da sala', 'Filmes', 'Jogos']);
    await expect(dialog.getByRole('heading', { level: 3 })).toHaveText([
      'No controle',
      'Fora do controle',
    ]);

    const search = dialog.getByRole('searchbox', { name: 'Buscar app' });
    await search.fill('CAMERA');
    await expect(names).toHaveText(['Câmera da sala']);
    await search.fill('pacote.app3');
    await expect(names).toHaveText(['Jogos']);
    await search.fill('zzz');
    await expect(dialog.getByText('Nenhum app encontrado para essa busca.')).toBeVisible();

    // A busca é uma lista só, sem seções; quem está no controle leva a marca (lida como descrição, o nome não muda).
    await search.fill('exemplo');
    await expect(dialog.getByRole('heading', { level: 3 })).toHaveCount(0);
    await expect(names).toHaveText(['Câmera da sala', 'Filmes', 'Jogos']);
    await expect(dialog.locator('.mark')).toHaveCount(2);
    await expect(button(dialog, 'Filmes')).toHaveAccessibleDescription('No controle');
    await expect(button(dialog, 'Jogos')).toHaveAccessibleDescription('');
    await expect(button(dialog, 'Jogos')).toBeEnabled();
    await settleMotion(page);
    await screenshot(page, `test-results/tv-apps-search-${info.project.name}.png`);
    await expectNoSeriousViolations(page);

    await search.fill('');
    await expect(dialog.getByRole('heading', { level: 3 })).toHaveCount(2);

    // Nada de Grade | Lista: o painel é sempre uma grade.
    await expect(dialog.getByRole('button', { name: 'Lista', exact: true })).toHaveCount(0);

    // Abrir um app continua valendo, e o que está fora do controle abre do mesmo jeito.
    await button(dialog, 'Filmes').click();
    await expect.poll(() => tv.count(`/shortcuts/${tv.shortcuts[1].id}/launch`)).toBe(1);
  });

  test('app instalado fora do controle abre ao toque, e app que saiu da TV não aparece', async ({
    page,
  }, info) => {
    // CineVS e Spotify no controle; Configurações, Play Store e "Atalho 5" instalados mas fora dele; YouTube saiu da TV.
    tv.shortcuts = iconShortcuts().map((s, index) => ({
      ...s,
      enabled: index < 2,
      installed: index !== 5,
    }));
    const [, , , playStore, , youtube] = tv.shortcuts;
    await openTv(page);
    // A fileira de cima segue só com os do controle.
    await expectChipNames(page, ['CineVS', 'Spotify']);

    await openApps(page);
    const dialog = appsDialog(page);
    await expect(dialog.getByRole('heading', { level: 3 })).toHaveText([
      'No controle',
      'Fora do controle',
    ]);
    await expect(dialog.locator('.item .name')).toHaveText([
      'CineVS',
      'Spotify',
      'Configurações',
      'Play Store',
      'Atalho 5',
    ]);
    await expect(
      dialog.getByText('Toque para abrir. Para ter no controle, fixe em Editar.'),
    ).toBeVisible();

    // Fora do controle não é apagado nem desabilitado: o azulejo é igual ao dos outros.
    await expect(dialog.locator('.launch:disabled')).toHaveCount(0);
    const opacities = await dialog
      .locator('.item .launch')
      .evaluateAll((els) => els.map((el) => getComputedStyle(el.querySelector('.art')!).opacity));
    expect(new Set(opacities.map(Number)).size, 'a mesma opacidade em todos os azulejos').toBe(1);

    // O app que saiu da TV não existe para o painel: nem na busca, nem na edição.
    const search = dialog.getByRole('searchbox', { name: 'Buscar app' });
    await search.fill('youtube');
    await expect(dialog.getByText('Nenhum app encontrado para essa busca.')).toBeVisible();
    await search.fill('');
    await button(dialog, 'Editar').click();
    await expect(dialog.locator('.item .name')).toHaveText([
      'CineVS',
      'Spotify',
      'Configurações',
      'Play Store',
      'Atalho 5',
    ]);
    await button(dialog, 'Concluir').click();

    for (const index of [0, 1, 2]) {
      await expect
        .poll(() => imageLoaded(dialog.locator('.item').nth(index).locator('img')))
        .toBe(true);
    }
    await expectNoHorizontalScroll(page);
    await settleMotion(page);
    await screenshot(page, `test-results/apps-launch-sections-${info.project.name}.png`);
    await expectNoSeriousViolations(page);

    // Tocar num app que está fora do controle o abre: o pedido sai com o id certo, e o painel fecha.
    await button(dialog, 'Play Store').click();
    await expect.poll(() => tv.count(`/shortcuts/${playStore.id}/launch`)).toBe(1);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Play Store aberto na TV.')).toBeVisible();
    // Nenhum pedido de abrir saiu para o que não está mais na TV, e a fileira não ganhou o app aberto.
    expect(tv.count(`/shortcuts/${youtube.id}/launch`)).toBe(0);
    await expectChipNames(page, ['CineVS', 'Spotify']);
  });

  test('sem a lista da TV: estado vazio amigável e "Buscar apps da TV" que mostra o resultado', async ({
    page,
  }, info) => {
    tv.shortcuts = [];
    await openTv(page);
    await openApps(page);
    const dialog = appsDialog(page);
    await expect(dialog.getByText('Ainda não temos a lista de apps da TV')).toBeVisible();
    await expect(dialog.getByRole('searchbox')).toHaveCount(0);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.getByText(/sem atalhos|nenhum atalho/i)).toHaveCount(0);
    await settleMotion(page);
    await screenshot(page, `test-results/tv-apps-empty-${info.project.name}.png`);
    await expectNoSeriousViolations(page);

    // A TV informa os apps: a lista aparece no lugar do estado vazio.
    await dialog.getByRole('button', { name: 'Buscar apps da TV' }).click();
    await expect.poll(() => tv.count('/shortcuts/refresh')).toBe(1);
    await expect(dialog.getByText('A TV ainda não informou nenhum app.')).toBeVisible();
    await emitSse(page, 'tv.shortcuts', SHORTCUTS);
    await expect(dialog.locator('.item .name')).toHaveCount(3);
    await expect(dialog.getByText('Ainda não temos a lista de apps da TV')).toHaveCount(0);
  });

  test('a falha ao buscar os apps aparece discreta, dentro do painel', async ({ page }) => {
    tv.shortcuts = [];
    await openTv(page);
    await openApps(page);
    const dialog = appsDialog(page);
    tv.commandFailure = { status: 504, kind: 'agent-timeout' };
    await dialog.getByRole('button', { name: 'Buscar apps da TV' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'A TV não respondeu a tempo. Tente de novo.',
    );
    await expect(dialog).toBeVisible();
    // Dá para tentar de novo.
    tv.commandFailure = null;
    await expect(dialog.getByRole('button', { name: 'Buscar apps da TV' })).toBeEnabled();
  });

  test('sem o agente o painel avisa o motivo e não deixa buscar', async ({ page }) => {
    tv.shortcuts = [];
    await openTv(page);
    await sendState(page, { agentOnline: false, connection: 'disconnected', volume: null });
    await openApps(page);
    const dialog = appsDialog(page);
    await expect(dialog.getByRole('button', { name: 'Buscar apps da TV' })).toBeDisabled();
    await expect(dialog.getByText('O agente da TV está desligado')).toBeVisible();
  });
});

test.describe('painel Teclado', () => {
  const texts = () => tv.requests.filter((r) => r.path === '/text').map((r) => r.body?.['text']);

  test('sem o agente o painel já diz o motivo, antes de digitar, e nada é enviado', async ({
    page,
  }, info) => {
    await openTv(page);
    await sendState(page, { agentOnline: false, connection: 'disconnected', volume: null });
    await openKeyboard(page);
    const note = keyboardDialog(page).getByRole('status').filter({ hasText: 'O agente da TV' });
    await expect(note).toBeVisible();
    await expect(note).toHaveText(
      'O agente da TV está desligado, então os botões não funcionam agora.',
    );
    await page.waitForTimeout(250);
    await screenshot(page, `test-results/tv-keyboard-agent-off-${info.project.name}.png`);
    await expectNoSeriousViolations(page);
    expect(texts()).toEqual([]);
  });

  test('o campo fica no topo do painel, já com o foco, sobre o controle', async ({
    page,
  }, info) => {
    await openTv(page);
    await openKeyboard(page);
    await expect(keyboardField(page)).toBeFocused();
    await expect(button(keyboardDialog(page), 'Enviar')).toHaveCount(0);
    await expect(
      keyboardDialog(page).getByText('O texto aparece no campo aberto na TV enquanto você digita.'),
    ).toBeVisible();
    // Só uma dica curta: sem os avisos compridos de antes.
    await expect(page.getByText('Pode funcionar só em caixas de busca')).toHaveCount(0);
    await expect(
      page.getByText('Para apagar tudo, use o botão de apagar da própria TV.'),
    ).toHaveCount(0);
    await expect(page.getByText('Texto vazio não é enviado.')).toHaveCount(0);
    await expect(keyboardDialog(page).getByRole('button')).toHaveText(['Limpar', 'Fechar']);

    // O painel é ancorado no topo: o teclado do aparelho não o cobre.
    const card = (await keyboardDialog(page).locator('.card').boundingBox())!;
    const field = (await keyboardField(page).boundingBox())!;
    expect(card.y).toBeLessThan(80);
    expect(field.y).toBeLessThan(card.y + card.height / 2);
    await expectNoHorizontalScroll(page);
    await page.waitForTimeout(250);
    await screenshot(page, `test-results/tv-keyboard-${info.project.name}.png`);
    await expectNoSeriousViolations(page);
  });

  test('o texto vai para a TV enquanto se digita, sem Enviar nem OK, e o campo não limpa', async ({
    page,
  }, info) => {
    await openTv(page);
    await openKeyboard(page);
    const field = keyboardField(page);
    // Digitação seguida: a primeira letra vai na hora e o resto se junta; o último envio tem o texto completo.
    await page.keyboard.type('batman', { delay: 40 });
    await expect.poll(() => texts().at(-1)).toBe('batman');
    await expect(page.getByText('Texto na TV.')).toBeVisible();
    // Cada envio é um prefixo do que se digitou, cada vez maior: nunca um pedaço solto, nem o mesmo texto de novo.
    const sent = texts() as string[];
    expect(sent[0]).toBe('b');
    sent.forEach((text, index) => {
      expect('batman'.startsWith(text)).toBe(true);
      if (index > 0) expect(text.length).toBeGreaterThan(sent[index - 1].length);
    });
    await page.waitForTimeout(700);
    expect(texts()).toEqual(sent);
    await expect(field).toHaveValue('batman');
    await page.waitForTimeout(250);
    await screenshot(page, `test-results/tv-keyboard-typed-${info.project.name}.png`);
    await expectNoSeriousViolations(page);
  });

  test('com pausas entre as letras o app manda o texto completo a cada pausa, nunca só o pedaço novo', async ({
    page,
  }) => {
    await openTv(page);
    await openKeyboard(page);
    for (const letter of ['b', 'a', 't']) {
      await page.keyboard.type(letter);
      await page.waitForTimeout(450);
    }
    expect(texts()).toEqual(['b', 'ba', 'bat']);
    // Apagar uma letra também sincroniza (o texto da TV passa a ser o do campo).
    await page.keyboard.press('Backspace');
    await expect.poll(() => texts()).toEqual(['b', 'ba', 'bat', 'ba']);
  });

  test('apagar até esvaziar manda o texto vazio para a TV, que apaga o que o agente digitou', async ({
    page,
  }) => {
    await openTv(page);
    await openKeyboard(page);
    const field = keyboardField(page);
    await field.fill('bat');
    await expect.poll(() => texts()).toEqual(['bat']);
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
    await expect(field).toHaveValue('');
    // O último pedido é o vazio (os do meio podem ter se juntado), e o app avisa que o campo da TV foi limpo.
    await expect.poll(() => texts().at(-1)).toBe('');
    await expect(page.getByText('Campo da TV limpo.')).toBeVisible();
    const sent = texts() as string[];
    sent.forEach((text) => expect('bat'.startsWith(text)).toBe(true));
    await page.waitForTimeout(700);
    expect(texts()).toEqual(sent);
  });

  test('apagar tudo de uma vez também manda o texto vazio', async ({ page }) => {
    await openTv(page);
    await openKeyboard(page);
    const field = keyboardField(page);
    await field.fill('bat');
    await expect.poll(() => texts()).toEqual(['bat']);
    await field.fill('');
    await expect.poll(() => texts()).toEqual(['bat', '']);
    await page.waitForTimeout(700);
    expect(texts()).toEqual(['bat', '']);
  });

  test('uma rajada de letras sai em poucas requisições, a primeira na hora e a última com o texto final', async ({
    page,
  }) => {
    await openTv(page);
    await openKeyboard(page);
    const field = keyboardField(page);
    // Tudo dentro de uma tarefa só do navegador: nenhuma resposta chega no meio, então o resultado não depende de tempo.
    await field.evaluate((element: HTMLInputElement) => {
      for (const text of ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef']) {
        element.value = text;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await expect.poll(() => texts().at(-1)).toBe('abcdef');
    // A primeira letra foi na hora; as outras cinco viraram uma requisição só (uma em voo por vez).
    expect(texts()).toEqual(['a', 'abcdef']);
    await page.waitForTimeout(700);
    expect(texts()).toEqual(['a', 'abcdef']);
  });

  test('Limpar esvazia o campo do celular e o da TV, e Fechar fecha o painel, enviando o que faltava', async ({
    page,
  }) => {
    await openTv(page);
    await openKeyboard(page);
    const field = keyboardField(page);
    await field.fill('bat');
    await expect.poll(() => texts()).toEqual(['bat']);
    await button(keyboardDialog(page), 'Limpar').click();
    await expect(field).toHaveValue('');
    await expect.poll(() => texts()).toEqual(['bat', '']);
    await expect(page.getByText('Campo da TV limpo.')).toBeVisible();
    await page.waitForTimeout(600);
    expect(texts()).toEqual(['bat', '']);

    // Duas mudanças seguidas e o painel fecha: o que ainda esperava a cauda não se perde.
    await field.evaluate((element: HTMLInputElement) => {
      for (const text of ['x', 'xy']) {
        element.value = text;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await button(keyboardDialog(page), 'Fechar').click();
    await expect(keyboardDialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/tv$/);
    await expect(button(page, 'Teclado')).toBeFocused();
    await expect.poll(() => texts().at(-1)).toBe('xy');
    expect(texts()).toEqual(['bat', '', 'x', 'xy']);
  });

  test('abrir e fechar o painel sem digitar não manda nada', async ({ page }) => {
    await openTv(page);
    await openKeyboard(page);
    await page.keyboard.press('Escape');
    await expect(keyboardDialog(page)).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(texts()).toEqual([]);
  });

  test('o painel fica aberto sobre o controle: dá para digitar e fechar sem trocar de tela', async ({
    page,
  }) => {
    await openTv(page);
    await openKeyboard(page);
    await keyboardField(page).fill('oi');
    await expect.poll(() => texts()).toEqual(['oi']);
    // O controle segue por trás (o endereço não mudou) e volta inteiro ao fechar.
    await expect(page).toHaveURL(/\/tv$/);
    await page.keyboard.press('Escape');
    await expect(keyboardDialog(page)).toHaveCount(0);
    await button(page, 'Menu').click();
    await expect.poll(() => tv.keysSent()).toEqual(['MENU']);
  });

  test('recusa mais de 200 caracteres: nada é enviado enquanto passar do limite', async ({
    page,
  }) => {
    await openTv(page);
    await openKeyboard(page);
    const field = keyboardField(page);
    await field.fill('a'.repeat(201));
    await expect(page.getByText('201 / 200')).toBeVisible();
    await expect(
      page.getByText('A TV recebe no máximo 200 caracteres', { exact: false }),
    ).toBeVisible();
    await page.waitForTimeout(700);
    expect(texts()).toEqual([]);
    await field.fill('a'.repeat(200));
    await expect.poll(() => texts()).toEqual(['a'.repeat(200)]);
  });

  test('falha mostra um erro discreto, não perde o texto e tenta de novo na próxima mudança', async ({
    page,
  }) => {
    await openTv(page);
    await openKeyboard(page);
    const field = keyboardField(page);
    tv.commandFailure = { status: 504, kind: 'agent-timeout' };
    await field.fill('bat');
    await expect(page.getByText('A TV não respondeu a tempo.', { exact: false })).toBeVisible();
    await expect(page.getByText('Continue digitando para tentar de novo.')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(field).toHaveValue('bat');
    await page.waitForTimeout(700);
    expect(texts()).toEqual(['bat']);

    tv.commandFailure = null;
    await field.pressSequentially('m');
    await expect.poll(() => texts()).toEqual(['bat', 'batm']);
    await expect(page.getByText('Texto na TV.')).toBeVisible();
    await expect(field).toHaveValue('batm');
  });
});

test.describe('acessibilidade e tema', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`controle, touchpad, painéis e painelzinho passam no axe no tema ${scheme}`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openTv(page);
      await sendState(page, { connection: 'hibernating' });
      await expect(statusDot(page, 'Dormindo')).toBeVisible();
      await screenshot(page, `test-results/tv-control-${scheme}-${info.project.name}.png`);
      await expectNoSeriousViolations(page);

      await dot(page, 2).click();
      await settlePage(page, 1);
      await expectNoSeriousViolations(page);
      await dot(page, 3).click();
      await settlePage(page, 2);
      await expectNoSeriousViolations(page);
      await dot(page, 1).click();
      await settlePage(page, 0);

      await statusDot(page).click();
      await expect(statusPanel(page)).toBeVisible();
      await screenshot(page, `test-results/tv-status-panel-${scheme}-${info.project.name}.png`);
      await expectNoSeriousViolations(page);
      await page.keyboard.press('Escape');

      await openApps(page);
      await expect(appsDialog(page).locator('.item')).toHaveCount(3);
      await settleMotion(page);
      await screenshot(page, `test-results/tv-apps-${scheme}-${info.project.name}.png`);
      await expectNoSeriousViolations(page);
      await page.keyboard.press('Escape');

      await openKeyboard(page);
      await settleMotion(page);
      await screenshot(page, `test-results/tv-keyboard-${scheme}-${info.project.name}.png`);
      await expectNoSeriousViolations(page);
    });
  }

  test('os pontos das páginas fora de vista têm contraste de 3:1 contra o fundo, nos dois temas', async ({
    page,
  }) => {
    await openTv(page);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      // O axe não mede contraste de elemento sem texto: aqui a conta é feita à mão (WCAG 1.4.11).
      const measured = await page.evaluate(() => {
        const channels = (color: string) => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const lum = ([r, g, b]: number[]) => {
          const [lr, lg, lb] = [r, g, b].map((v) => {
            const c = v / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
        };
        const mark = document.querySelectorAll('app-page-dots .mark')[1] as HTMLElement;
        const style = getComputedStyle(mark);
        const background = channels(getComputedStyle(document.body).backgroundColor);
        const opacity = Number(style.opacity);
        const own = channels(style.backgroundColor);
        const shown = own.map((v, i) => v * opacity + background[i] * (1 - opacity));
        const [a, b] = [lum(shown), lum(background)].sort((x, y) => y - x);
        return { ratio: (a + 0.05) / (b + 0.05), opacity };
      });
      expect(measured.opacity, `opacidade do ponto (${scheme})`).toBe(1);
      expect(measured.ratio, `contraste do ponto (${scheme})`).toBeGreaterThanOrEqual(3);
    }
  });

  test('o foco do teclado é visível nos botões, nos setores do anel, no botão Apps e nos atalhos', async ({
    page,
  }) => {
    await openTv(page);
    await button(page, 'Para cima').focus();
    const outline = await button(page, 'Para cima')
      .locator('.glyph')
      .evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe('solid');
    for (const name of ['Menu', 'Mais opções', 'Atalho 1']) {
      await button(page, name).focus();
      const style = await button(page, name).evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(style, name).toBe('solid');
    }
  });
});

/** Caixa de cada elemento fixo do controle (tudo que não é o palco que troca de página). */
async function fixedBoxes(page: Page) {
  const targets: [string, Locator][] = [
    ['menu', button(page, 'Mais opções')],
    ['atalho', button(page, 'Atalho 1')],
    ['volume+', button(page, 'Aumentar o volume')],
    ['voltar', button(page, 'Voltar')],
    ['menu', button(page, 'Menu')],
    ['teclado', button(page, 'Teclado')],
    ['anterior', button(page, 'Anterior')],
    ['canal+', button(page, 'Próximo canal')],
    ['ponto 1', dot(page, 1)],
    ['ponto 2', dot(page, 2)],
    ['ponto 3', dot(page, 3)],
    ['palco', page.locator('.viewport')],
  ];
  const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const [name, locator] of targets) {
    if ((await locator.count()) === 0) continue;
    boxes[name] = (await locator.boundingBox())!;
  }
  return boxes;
}

test.describe('controle: aproveita a altura', () => {
  test('o controle preenche a tela: pouco vazio embaixo e o anel enche o palco', async ({
    page,
  }) => {
    await openTv(page);
    const bottom = (await page.locator('.bottom').boundingBox())!;
    const viewport = page.viewportSize()!;
    // Sem barra de abas, a fileira de baixo vai até a margem da tela (16 px de respiro mais a área segura).
    const gap = viewport.height - (bottom.y + bottom.height);
    expect(gap, 'vazio entre os botões de baixo e a borda da tela').toBeLessThanOrEqual(28);

    const stage = (await page.locator('.viewport').boundingBox())!;
    const ring = (await page.locator('.ring').boundingBox())!;
    expect(ring.width).toBeGreaterThanOrEqual(0.85 * Math.min(stage.width, stage.height));
    expect(Math.abs(ring.width - ring.height)).toBeLessThanOrEqual(1);
    await expectNoVerticalScroll(page);
    await expectNoHorizontalScroll(page);
  });

  test('com a linha do motivo o controle continua sem rolar', async ({ page }) => {
    await openTv(page);
    await sendState(page, { agentOnline: false, connection: 'disconnected', volume: null });
    await expect(page.locator('.reason')).toBeVisible();
    await expectNoVerticalScroll(page);
    await expectNoHorizontalScroll(page);
    await expectTargetSize(dot(page, 3));
  });
});

/** Mesmas provas em outros tamanhos de tela (tablet, celular deitado, computador). */
const SCREENS = [
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'paisagem', width: 844, height: 390 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

for (const screen of SCREENS) {
  test.describe(`controle em ${screen.name} (${screen.width}x${screen.height})`, () => {
    test.use({ viewport: { width: screen.width, height: screen.height } });

    test('cabe sem rolagem, com alvos de 44 px e sem esticar', async ({ page }, info) => {
      await openTv(page);
      await expect(button(page, 'OK')).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoVerticalScroll(page);

      for (const name of [
        'Aumentar o volume',
        'Diminuir o volume',
        'Próximo canal',
        'Canal anterior',
        'Voltar',
        'Início da TV',
        'Menu',
        'Mudo',
        'Reproduzir ou pausar',
        'Anterior',
        'Próxima',
        'Teclado',
        'Desligar a TV',
        'Mais opções',
        'Atalho 1',
        'Página 1 de 3',
        'Página 2 de 3',
        'Página 3 de 3',
        'OK',
      ]) {
        await expectTargetSize(button(page, name));
      }
      await expectTargetSize(statusDot(page));

      const tvBox = (await page.locator('.tv').boundingBox())!;
      const limit = screen.width > screen.height ? 960 : 576;
      expect(tvBox.width).toBeLessThanOrEqual(limit + 1);
      // Centralizado: as margens dos dois lados são iguais.
      expect(Math.abs(tvBox.x - (screen.width - tvBox.x - tvBox.width))).toBeLessThanOrEqual(2);

      const ring = (await page.locator('.ring').boundingBox())!;
      const stage = (await page.locator('.viewport').boundingBox())!;
      expect(ring.width).toBeGreaterThanOrEqual(0.8 * Math.min(stage.width, stage.height));
      await screenshot(page, `test-results/tv-control-${screen.name}-${info.project.name}.png`);
      await expectNoSeriousViolations(page);
    });

    test('touchpad e números têm alvos de 44 px e os fixos não mexem', async ({ page }, info) => {
      await openTv(page);
      const before = await fixedBoxes(page);

      await dot(page, 2).click();
      await settlePage(page, 1);
      for (const digit of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
        await expectTargetSize(button(numbersPage(page), `Número ${digit}`));
      }
      await expectTargetSize(button(numbersPage(page), 'Origem'));
      expect(await fixedBoxes(page)).toEqual(before);
      await expectNoHorizontalScroll(page);
      await screenshot(page, `test-results/tv-numbers-${screen.name}-${info.project.name}.png`);

      await dot(page, 3).click();
      await settlePage(page, 2);
      const pad = (await page.locator('app-touchpad-surface .pad').boundingBox())!;
      expect(pad.height).toBeGreaterThanOrEqual(120);
      await expectNoHorizontalScroll(page);
      await screenshot(page, `test-results/tv-touchpad-${screen.name}-${info.project.name}.png`);
    });

    test('os painéis cabem na tela, sem rolagem horizontal', async ({ page }, info) => {
      await openTv(page);
      for (const [open, dialog, label] of [
        [openApps, appsDialog, 'apps'],
        [openKeyboard, keyboardDialog, 'keyboard'],
      ] as const) {
        await open(page);
        await settleMotion(page);
        const card = (await dialog(page).locator('.card').boundingBox())!;
        expect(card.x, `${label} x`).toBeGreaterThanOrEqual(0);
        expect(card.y, `${label} y`).toBeGreaterThanOrEqual(0);
        expect(card.x + card.width, `${label} direita`).toBeLessThanOrEqual(screen.width);
        expect(card.y + card.height, `${label} base`).toBeLessThanOrEqual(screen.height);
        await expectNoHorizontalScroll(page);
        await screenshot(
          page,
          `test-results/tv-${label}-panel-${screen.name}-${info.project.name}.png`,
        );
        await page.keyboard.press('Escape');
        await expect(dialog(page)).toHaveCount(0);
      }
    });
  });
}

test.describe('carrossel do palco: o indicador e a posição não perdem o fio', () => {
  test('tocar num ponto distante leva o indicador direto, sem passar pelas páginas do caminho', async ({
    page,
  }) => {
    await openTv(page);
    await page.evaluate(() => {
      const w = window as unknown as { __seq: number[] };
      w.__seq = [];
      const dots = [...document.querySelectorAll('app-page-dots .dot')];
      const observer = new MutationObserver(() => {
        const index = dots.findIndex((d) => d.getAttribute('aria-current') === 'true');
        if (w.__seq[w.__seq.length - 1] !== index) w.__seq.push(index);
      });
      dots.forEach((d) =>
        observer.observe(d, { attributes: true, attributeFilter: ['aria-current'] }),
      );
    });
    await dot(page, 3).click();
    await settlePage(page, 2);
    await page.waitForTimeout(300);
    const seen = await page.evaluate(() => (window as unknown as { __seq: number[] }).__seq);
    expect(seen, 'o indicador só pode ir ao destino, sem voltar nem parar no meio').toEqual([2]);
  });

  test('redimensionar a janela com a página 2 à vista não deixa o carrossel preso no meio', async ({
    page,
  }) => {
    await openTv(page);
    await dot(page, 2).click();
    await settlePage(page, 1);
    await page.setViewportSize({ width: 340, height: 640 });
    await expect(dot(page, 2)).toHaveAttribute('aria-current', 'true');
    await settlePage(page, 1);
    await page.setViewportSize({ width: 430, height: 700 });
    await settlePage(page, 1);
    await expect(dot(page, 2)).toHaveAttribute('aria-current', 'true');
  });

  test('recarregar a tela volta à mesma página do palco', async ({ page }) => {
    await openTv(page);
    await dot(page, 2).click();
    await settlePage(page, 1);
    await page.reload();
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await emitSse(page, 'tv.state', tv.state);
    await emitSse(page, 'tv.shortcuts', tv.shortcuts);
    await expect(dot(page, 2)).toHaveAttribute('aria-current', 'true');
    await settlePage(page, 1);
  });

  test('com "reduzir movimento" a troca de página é seca, sem a rolagem animada', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openTv(page);
    await dot(page, 3).click();
    // Dois quadros depois do toque a posição já chegou: uma rolagem animada levaria uns 300 ms.
    const distance = await page
      .locator('.pager')
      .evaluate(
        (el) =>
          new Promise<number>((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve(Math.abs(el.scrollLeft - 2 * el.clientWidth))),
            ),
          ),
      );
    expect(distance).toBeLessThanOrEqual(1);
    await expect(dot(page, 3)).toHaveAttribute('aria-current', 'true');
  });
});

/** Gesto de toque com ritmo: `steps` passos de `stepMs` cada, sem soltar se `release` for falso. */
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { steps: number; stepMs: number; release?: boolean },
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let step = 1; step <= opts.steps; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * step) / opts.steps,
          y: from.y + ((to.y - from.y) * step) / opts.steps,
        },
      ],
    });
    await page.waitForTimeout(opts.stepMs);
  }
  if (opts.release !== false) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  return cdp;
}

test.describe('carrossel do palco: gestos de dedo (toque sintético, só Chromium)', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'o gesto de toque sintético só existe no Chromium');
  });

  const stageBox = (page: Page) => page.locator('.viewport').boundingBox();

  test('arrasto lento: passando da metade vira a página, antes da metade volta', async ({
    page,
  }) => {
    await openTv(page);
    const box = (await stageBox(page))!;
    const y = box.y + box.height / 2;
    // Menos de um terço da largura, devagar: fica na página 1.
    await drag(
      page,
      { x: box.x + box.width * 0.7, y },
      { x: box.x + box.width * 0.45, y },
      {
        steps: 25,
        stepMs: 40,
      },
    );
    await settlePage(page, 0);
    await expect(dot(page, 1)).toHaveAttribute('aria-current', 'true');
    // Quase toda a largura, devagar: vai para a página 2.
    await drag(
      page,
      { x: box.x + box.width * 0.9, y },
      { x: box.x + box.width * 0.1, y },
      {
        steps: 25,
        stepMs: 40,
      },
    );
    await settlePage(page, 1);
    await expect(dot(page, 2)).toHaveAttribute('aria-current', 'true');
    expect(tv.keysSent()).toEqual([]);
  });

  test('toque rápido e curto (flick) avança uma página, e um flick enorme não pula duas', async ({
    page,
  }) => {
    await openTv(page);
    const box = (await stageBox(page))!;
    const y = box.y + box.height / 2;
    await drag(
      page,
      { x: box.x + box.width * 0.75, y },
      { x: box.x + box.width * 0.45, y },
      {
        steps: 4,
        stepMs: 8,
      },
    );
    await settlePage(page, 1);
    await expect(dot(page, 2)).toHaveAttribute('aria-current', 'true');
    await drag(
      page,
      { x: box.x + box.width * 0.95, y },
      { x: box.x + 2, y },
      {
        steps: 4,
        stepMs: 6,
      },
    );
    await page.waitForTimeout(500);
    const left = await page.locator('.pager').evaluate((el) => el.scrollLeft / el.clientWidth);
    expect(left, 'um deslize só passa uma página').toBeLessThanOrEqual(2.01);
    await expect(dot(page, 3)).toHaveAttribute('aria-current', 'true');
  });

  test('o dedo para a meio caminho: o indicador acompanha o arrasto e solta junto com a página', async ({
    page,
  }) => {
    await openTv(page);
    const box = (await stageBox(page))!;
    const y = box.y + box.height / 2;
    // O dedo anda 65% da largura e fica parado, sem soltar: mais da metade da página, menos que ela inteira.
    const cdp = await drag(
      page,
      { x: box.x + box.width * 0.85, y },
      { x: box.x + box.width * 0.2, y },
      { steps: 12, stepMs: 20, release: false },
    );
    const progress = await page.locator('.pager').evaluate((el) => el.scrollLeft / el.clientWidth);
    expect(progress).toBeGreaterThan(0.5);
    expect(progress).toBeLessThan(0.8);
    const thumb = page.locator('app-page-dots .thumb');
    await expect(thumb).toHaveCount(1);
    const dots = page.locator('app-page-dots .dot');
    const first = (await dots.nth(0).boundingBox())!;
    const second = (await dots.nth(1).boundingBox())!;
    const t = (await thumb.boundingBox())!;
    const centre = t.x + t.width / 2;
    expect(centre, 'o indicador saiu do primeiro ponto').toBeGreaterThan(
      first.x + first.width / 2 + 4,
    );
    expect(centre, 'o indicador ainda não chegou ao segundo').toBeLessThan(
      second.x + second.width / 2,
    );
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settlePage(page, 1);
    await expect(dot(page, 2)).toHaveAttribute('aria-current', 'true');
    expect(tv.keysSent()).toEqual([]);
  });

  test('tocar num ponto no meio de uma animação e depois arrastar não deixa o carrossel brigar consigo', async ({
    page,
  }) => {
    await openTv(page);
    await dot(page, 3).click();
    await page.waitForTimeout(60);
    const box = (await stageBox(page))!;
    const y = box.y + box.height / 2;
    await drag(
      page,
      { x: box.x + box.width * 0.2, y },
      { x: box.x + box.width * 0.85, y },
      {
        steps: 10,
        stepMs: 16,
      },
    );
    // Espera o encaixe terminar em vez de uma pausa fixa: num executor lento a animação ainda corre aos 500 ms.
    // Carrossel realmente preso no meio nunca encaixa, e o poll estoura.
    await expect
      .poll(
        () =>
          page.locator('.pager').evaluate((el) => {
            const ratio = el.scrollLeft / el.clientWidth;
            return Math.abs(ratio - Math.round(ratio));
          }),
        { message: 'preso no meio' },
      )
      .toBeLessThan(0.02);
    const index = await page
      .locator('.pager')
      .evaluate((el) => Math.round(el.scrollLeft / el.clientWidth));
    await expect(dot(page, (index + 1) as 1 | 2 | 3)).toHaveAttribute('aria-current', 'true');
  });

  test('segurar uma seta e arrastar vira a página e para de repetir a tecla', async ({ page }) => {
    await openTv(page);
    const right = (await button(page, 'Para a direita').boundingBox())!;
    const box = (await stageBox(page))!;
    const from = { x: right.x + right.width * 0.86, y: right.y + right.height * 0.5 };
    await drag(page, from, { x: box.x + 4, y: from.y }, { steps: 12, stepMs: 20 });
    await settlePage(page, 1);
    const before = tv.keysSent().length;
    await page.waitForTimeout(900);
    expect(tv.keysSent().length, 'a repetição continuou depois do gesto').toBe(before);
    expect(tv.keysSent()).toEqual([]);
  });
});

/** Seis apps com todos os casos: banner, quadrado, fundo transparente, sem ícone, nome padrão e imagem quebrada. */
function iconShortcuts(): MockShortcut[] {
  const rows: Pick<MockShortcut, 'tvLabel' | 'package' | 'iconDataUri'>[] = [
    { tvLabel: 'CineVS', package: 'exemplo.cine', iconDataUri: ICONS.banner },
    { tvLabel: 'Spotify', package: 'exemplo.musica', iconDataUri: ICONS.square },
    { tvLabel: 'Configurações', package: 'exemplo.ajustes', iconDataUri: ICONS.transparent },
    { tvLabel: 'Play Store', package: 'exemplo.loja', iconDataUri: null },
    { tvLabel: null, package: 'exemplo.sem.nome', iconDataUri: null },
    { tvLabel: 'YouTube', package: 'exemplo.video', iconDataUri: BROKEN_PNG },
  ];
  return rows.map((row, index) => ({
    id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
    position: index + 1,
    customLabel: null,
    enabled: true,
    installed: true,
    ...row,
  }));
}
const ICON_NAMES = ['CineVS', 'Spotify', 'Configurações', 'Play Store', 'Atalho 5', 'YouTube'];

const imageLoaded = (image: Locator) =>
  image.evaluate(
    (el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0,
  );

/** Contraste WCAG da letra de cada azulejo de reserva da tela contra o fundo dele (o axe não mede texto escondido). */
async function fallbackContrasts(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const channels = (color: string) => {
      const numbers = (color.match(/-?\d*\.?\d+/g) ?? []).slice(0, 3).map(Number);
      return color.startsWith('color(') ? numbers.map((v) => v * 255) : numbers;
    };
    const lum = ([r, g, b]: number[]) => {
      const [lr, lg, lb] = [r, g, b].map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    return [...document.querySelectorAll<HTMLElement>('.fallback')].map((el) => {
      const style = getComputedStyle(el);
      const [a, b] = [lum(channels(style.color)), lum(channels(style.backgroundColor))].sort(
        (x, y) => y - x,
      );
      return (a + 0.05) / (b + 0.05);
    });
  });
}

test.describe('ícones dos apps', () => {
  test('a fileira de cima mostra o ícone no lugar do nome, e o nome segue no botão e na dica', async ({
    page,
  }) => {
    tv.shortcuts = iconShortcuts();
    await openTv(page);
    await expectChipNames(page, ICON_NAMES);
    const chips = page.locator('.shortcuts .shortcut');
    for (const [index, name] of ICON_NAMES.entries()) {
      await expect(chips.nth(index)).toHaveAttribute('title', name);
    }
    // Com ícone: só a imagem, decorativa (alt vazio), sem texto.
    for (const index of [0, 1, 2]) {
      await expect(chips.nth(index)).toHaveText('');
      await expect(chips.nth(index).locator('img')).toHaveAttribute('alt', '');
      await expect.poll(() => imageLoaded(chips.nth(index).locator('img'))).toBe(true);
    }
    // Sem ícone: a inicial do nome (ou o número da posição, no "Atalho n"), escondida de leitor de tela.
    await expect(chips.nth(3).locator('.fallback')).toHaveText('P');
    await expect(chips.nth(4).locator('.fallback')).toHaveText('5');
    await expect(chips.nth(3).locator('.fallback')).toHaveAttribute('aria-hidden', 'true');
    // A imagem que não carrega cai no azulejo de reserva, sem quebrar a fileira.
    await expect(chips.nth(5).locator('.fallback')).toHaveText('Y');
    await expect(chips.nth(5).locator('img')).toHaveCount(0);
    await expect(button(page, 'Mais opções')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoVerticalScroll(page);
  });

  test('todos os azulejos são quadrados do mesmo tamanho: ícone quadrado, banner, sem ícone e imagem quebrada', async ({
    page,
  }) => {
    tv.shortcuts = iconShortcuts();
    await openTv(page);
    const chips = page.locator('.shortcuts .shortcut');
    for (const index of [0, 1, 2]) {
      await expect.poll(() => imageLoaded(chips.nth(index).locator('img'))).toBe(true);
    }
    // A imagem quebrada já caiu no azulejo de reserva: a medida vale para os seis casos.
    await expect(chips.nth(5).locator('.fallback')).toBeVisible();
    await expect(chips).toHaveCount(6);

    const side = await expectSameSquares(chips);
    // O lado é a altura que a fileira já tinha (a variável `--tv-top`, lida na altura mínima da fileira).
    const rowHeight = await page
      .locator('.top')
      .evaluate((el) => parseFloat(getComputedStyle(el).minHeight));
    expect(side, 'lado do azulejo = altura da fileira').toBeCloseTo(rowHeight, 0);
    await expectSameSquares(chips.locator('app-tv-app-icon'));

    // Cantos arredondados iguais em todos.
    const radii = await chips.evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).borderTopLeftRadius),
    );
    expect(new Set(radii).size, 'um só raio de canto').toBe(1);
    expect(parseFloat(radii[0])).toBeGreaterThan(8);

    // O ícone enche o azulejo de ponta a ponta (`cover`, sem folga interna), em qualquer formato: o banner 16:9 perde um
    // pouco dos lados em vez de deixar faixas, e a caixa da imagem é a do azulejo (o recorte da margem do próprio ícone
    // é um `transform`, que não muda a caixa de layout).
    const fits = await chips.evaluateAll((els) =>
      els.flatMap((el) => {
        const image = el.querySelector('img');
        if (!image) return [];
        const tile = el.querySelector('app-tv-app-icon')!.getBoundingClientRect();
        const style = getComputedStyle(image);
        return [
          {
            objectFit: style.objectFit,
            objectPosition: style.objectPosition,
            padding: style.padding,
            naturalRatio: image.naturalWidth / image.naturalHeight,
            widthGap: image.offsetWidth - tile.width,
            heightGap: image.offsetHeight - tile.height,
          },
        ];
      }),
    );
    expect(fits).toHaveLength(3);
    const [banner, square] = fits;
    for (const fit of fits) {
      expect(fit.objectFit).toBe('cover');
      expect(fit.objectPosition).toBe('50% 50%');
      expect(fit.padding, 'sem folga interna').toBe('0px');
      for (const gap of [fit.widthGap, fit.heightGap]) {
        expect(Math.abs(gap), 'a imagem tem a caixa do azulejo').toBeLessThanOrEqual(1);
      }
    }
    // O banner é 16:9 e o quadrado não: a forma da imagem muda, a do azulejo não.
    expect(banner.naturalRatio).toBeGreaterThan(1.6);
    expect(square.naturalRatio).toBeCloseTo(1, 1);
    for (const index of [0, 1, 2, 3, 4, 5]) await expectTargetSize(chips.nth(index));
  });

  test('a faixa rola alinhada ao início, e nada passa da largura da tela', async ({ page }) => {
    // Cinco azulejos de 60 px cabem na largura do celular (seis já passam dela): mais quatro garantem a rolagem.
    tv.shortcuts = [
      ...iconShortcuts(),
      ...[7, 8, 9, 10].map((position) => ({
        id: `00000000-0000-4000-8000-${String(300 + position).padStart(12, '0')}`,
        position,
        package: `exemplo.extra${position}`,
        tvLabel: null,
        customLabel: `Extra ${position}`,
        enabled: true,
        installed: true,
        iconDataUri: ICONS.square,
      })),
    ];
    await openTv(page);
    const strip = page.locator('.shortcuts');
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await strip.evaluate((el) => el.scrollLeft)).toBe(0);
    // O primeiro azulejo começa no início da faixa (a folga de 5 px do anel de foco é devolvida pela margem).
    const stripBox = (await strip.boundingBox())!;
    const first = (await page.locator('.shortcuts .shortcut').first().boundingBox())!;
    expect(first.x - stripBox.x).toBeCloseTo(5, 0);
    await strip.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    await expect
      .poll(() => strip.evaluate((el) => el.scrollLeft + el.clientWidth >= el.scrollWidth - 1))
      .toBe(true);
    const last = (await button(page, 'Extra 10').boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(last.x + last.width).toBeLessThanOrEqual(stripBox.x + stripBox.width + 0.5);
    expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(viewport.width);
    await expectNoHorizontalScroll(page);
    await expectNoVerticalScroll(page);
  });

  test('tocar no ícone abre o app', async ({ page }) => {
    tv.shortcuts = iconShortcuts();
    await openTv(page);
    await button(page, 'Spotify').click();
    await expect.poll(() => tv.count(`/shortcuts/${tv.shortcuts[1].id}/launch`)).toBe(1);
    await expect(page.getByText('Spotify aberto na TV.')).toBeVisible();
    // O banner também: o toque na própria imagem chega ao azulejo (a imagem não recebe o toque, quem recebe é o botão).
    const picture = (await button(page, 'CineVS').locator('img').boundingBox())!;
    await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
    await expect.poll(() => tv.count(`/shortcuts/${tv.shortcuts[0].id}/launch`)).toBe(1);
  });

  test('sem o agente os ícones ficam apagados mas focáveis, e o toque não abre nada', async ({
    page,
  }) => {
    tv.shortcuts = iconShortcuts();
    await openTv(page);
    await sendState(page, { agentOnline: false, connection: 'disconnected', volume: null });
    const chip = button(page, 'Spotify');
    await expect(chip).toHaveAttribute('aria-disabled', 'true');
    // Apagado só por aria-disabled: o botão não está desabilitado de verdade, para a faixa seguir focável.
    expect(await chip.evaluate((el) => (el as HTMLButtonElement).disabled)).toBe(false);
    expect(await chip.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.6);
    await chip.focus();
    await expect(chip).toBeFocused();
    await chip.click({ force: true });
    await page.waitForTimeout(150);
    expect(tv.count(`/shortcuts/${tv.shortcuts[1].id}/launch`)).toBe(0);
  });

  test('o foco do teclado aparece inteiro em volta do chip, sem ser cortado pela faixa que rola', async ({
    page,
  }, info) => {
    tv.shortcuts = iconShortcuts();
    await openTv(page);
    const strip = (await page.locator('.shortcuts').boundingBox())!;
    for (const name of ['CineVS', 'Spotify']) {
      const chip = button(page, name);
      await chip.focus();
      const focus = await chip.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          style: style.outlineStyle,
          width: parseFloat(style.outlineWidth),
          offset: parseFloat(style.outlineOffset),
        };
      });
      expect(focus.style, name).toBe('solid');
      expect(focus.width, name).toBeGreaterThanOrEqual(2);
      // O anel (largura + distância) cabe na faixa, em cima, embaixo e à esquerda: nada a cortar.
      const reach = focus.width + Math.max(focus.offset, 0);
      const box = (await chip.boundingBox())!;
      expect(box.y - reach, name + ': em cima').toBeGreaterThanOrEqual(strip.y - 0.5);
      expect(box.y + box.height + reach, name + ': embaixo').toBeLessThanOrEqual(
        strip.y + strip.height + 0.5,
      );
      if (name === 'CineVS') {
        expect(box.x - reach, name + ': à esquerda').toBeGreaterThanOrEqual(strip.x - 0.5);
      }
    }
    await screenshot(page, `test-results/tv-icons-focus-${info.project.name}.png`);
  });

  test('um WebP também aparece', async ({ page }) => {
    tv.shortcuts = iconShortcuts().map((s, index) =>
      index === 3 ? { ...s, iconDataUri: TINY_WEBP } : s,
    );
    await openTv(page);
    const image = button(page, 'Play Store').locator('img');
    await expect(image).toHaveCount(1);
    await expect.poll(() => imageLoaded(image)).toBe(true);
  });

  test('um atalho sem o campo do ícone (guardado antes dele existir) vira azulejo, sem erro', async ({
    page,
  }) => {
    tv.shortcuts = iconShortcuts().map((s, index) => {
      const old: MockShortcut = { ...s };
      if (index === 1) delete old.iconDataUri;
      return old;
    });
    await openTv(page);
    await expect(button(page, 'Spotify').locator('.fallback')).toHaveText('S');
    await expect(button(page, 'CineVS').locator('img')).toHaveCount(1);
  });

  test('o ícone chega depois da lista pelo fluxo e troca o azulejo, sem mexer na ordem', async ({
    page,
  }) => {
    tv.shortcuts = iconShortcuts();
    await openTv(page);
    await expect(button(page, 'Play Store').locator('.fallback')).toHaveText('P');
    await emitSse(
      page,
      'tv.shortcuts',
      tv.shortcuts.map((s) =>
        s.tvLabel === 'Play Store' ? { ...s, iconDataUri: ICONS.square } : s,
      ),
    );
    await expect(button(page, 'Play Store').locator('img')).toHaveCount(1);
    await expect(button(page, 'Play Store').locator('.fallback')).toHaveCount(0);
    await expectChipNames(page, ICON_NAMES);
  });

  test.describe('painel Apps', () => {
    const LONG = 'Aplicativo com um nome bem comprido que passa de duas linhas na grade';

    test('na grade todo azulejo é um quadrado do mesmo tamanho, com o ícone grande e o nome embaixo em até duas linhas', async ({
      page,
    }) => {
      tv.shortcuts = [
        ...iconShortcuts(),
        {
          id: '00000000-0000-4000-8000-000000000199',
          position: 7,
          package: 'exemplo.comprido',
          tvLabel: null,
          customLabel: LONG,
          enabled: true,
          installed: true,
          iconDataUri: ICONS.square,
        },
      ];
      await openTv(page);
      await openApps(page);
      const dialog = appsDialog(page);
      const items = dialog.locator('.item');
      await expect(items).toHaveCount(7);
      await settleMotion(page);
      const dialogBox = (await dialog.boundingBox())!;

      // Banner, quadrado, transparente, sem ícone, "Atalho n", imagem quebrada e o de nome longo: todos iguais.
      for (const index of [0, 1, 2, 6]) {
        await items.nth(index).scrollIntoViewIfNeeded();
        await expect.poll(() => imageLoaded(items.nth(index).locator('img'))).toBe(true);
      }
      await items.nth(5).scrollIntoViewIfNeeded();
      await expect(items.nth(5).locator('.fallback')).toBeVisible();
      const side = await expectSameSquares(dialog.locator('.item .art app-tv-app-icon'));
      expect(side, 'ícone grande').toBeGreaterThanOrEqual(55);

      for (let index = 0; index < 7; index++) {
        const item = items.nth(index);
        await item.scrollIntoViewIfNeeded();
        const tile = (await item.locator('app-tv-app-icon').boundingBox())!;
        const name = (await item.locator('.name').boundingBox())!;
        const launch = (await item.locator('.launch').boundingBox())!;
        expect(name.y, `nome ${index + 1} embaixo do ícone`).toBeGreaterThanOrEqual(
          tile.y + tile.height - 1,
        );
        expect(tile.x + tile.width, 'ícone dentro do azulejo').toBeLessThanOrEqual(
          launch.x + launch.width + 0.5,
        );
        expect(launch.x + launch.width, 'azulejo dentro do painel').toBeLessThanOrEqual(
          dialogBox.x + dialogBox.width + 0.5,
        );
        expect(launch.width, `alvo ${index + 1}`).toBeGreaterThanOrEqual(43.5);
        expect(launch.height, `alvo ${index + 1}`).toBeGreaterThanOrEqual(43.5);
        const lines = await item.locator('.name').evaluate((el) => {
          const style = getComputedStyle(el);
          const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
          return Math.round(el.getBoundingClientRect().height / line);
        });
        expect(lines, `linhas do nome ${index + 1}`).toBeLessThanOrEqual(2);
        // Nenhuma palavra do nome é partida no meio (sem hifenização nem quebra dentro da palavra): cada palavra tem uma
        // única caixa de linha. Quantas linhas o nome usa depende da fonte do sistema, e isto não.
        const broken = await item.locator('.name').evaluate((el) => {
          const node = el.firstChild as Text;
          return [...node.data.matchAll(/\S+/g)]
            .filter((match) => {
              const range = document.createRange();
              range.setStart(node, match.index);
              range.setEnd(node, match.index + match[0].length);
              return (
                new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size > 1
              );
            })
            .map((match) => match[0]);
        });
        expect(broken, `palavras partidas no meio no nome ${index + 1}`).toEqual([]);
      }
      // "Configurações", a palavra mais comprida de um app comum, cabe no rótulo com folga de pelo menos 8%. A largura do
      // texto depende da fonte do sistema (a do Linux é bem mais larga que a do Windows), então a medida usa uma fonte de
      // referência que os dois têm, com as mesmas métricas: Arial (no Linux, a Liberation Sans). O rótulo dispõe da coluna
      // mais 4 px de cada folga (apps-tile.css).
      const slack = await items
        .nth(2)
        .locator('.name')
        .evaluate((el) => {
          const css = getComputedStyle(el);
          const context = document.createElement('canvas').getContext('2d')!;
          context.font = `${css.fontWeight} ${css.fontSize} Arial, "Liberation Sans", sans-serif`;
          const text = el.textContent!.trim();
          const natural =
            context.measureText(text).width + (parseFloat(css.letterSpacing) || 0) * text.length;
          return 1 - natural / (el.parentElement!.clientWidth + 8);
        });
      expect(slack, 'folga da palavra mais comprida no rótulo').toBeGreaterThanOrEqual(0.08);

      // O de nome longo corta com reticências (nunca estoura o azulejo).
      expect(
        await items
          .nth(6)
          .locator('.name')
          .evaluate((el) => el.scrollHeight > el.clientHeight),
      ).toBe(true);

      // Colunas automáticas: no celular em pé são cerca de quatro por linha.
      await dialog.locator('.body').evaluate((el) => (el.scrollTop = 0));
      const rows = await items.evaluateAll((els) => {
        const tops = els.map((el) => Math.round(el.getBoundingClientRect().top));
        return tops.filter((top) => top === tops[0]).length;
      });
      expect(rows, 'azulejos na primeira linha').toBeGreaterThanOrEqual(4);
      const overflow = await dialog
        .locator('.body')
        .evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow, 'sem rolagem horizontal no painel').toBeLessThanOrEqual(0);
      await expectNoHorizontalScroll(page);
    });

    test('na edição cada azulejo mostra o pacote e os dois botões de 44 px, e a busca e o renomear seguem valendo', async ({
      page,
    }) => {
      tv.shortcuts = iconShortcuts();
      await openTv(page);
      await openApps(page);
      const dialog = appsDialog(page);
      await button(dialog, 'Editar').click();
      await expect(dialog.getByRole('heading', { level: 3, name: 'Todos os apps' })).toBeVisible();
      const items = dialog.locator('.item');
      await expect(items).toHaveCount(6);
      await settleMotion(page);
      for (let index = 0; index < 6; index++) {
        const item = items.nth(index);
        await item.scrollIntoViewIfNeeded();
        const card = (await item.boundingBox())!;
        const tools = item.locator('.tool');
        await expect(tools).toHaveCount(2);
        for (const tool of [tools.nth(0), tools.nth(1)]) {
          await expectTargetSize(tool);
          const box = (await tool.boundingBox())!;
          expect(box.x, 'botão dentro do cartão').toBeGreaterThanOrEqual(card.x - 0.5);
          expect(box.x + box.width, 'botão dentro do cartão').toBeLessThanOrEqual(
            card.x + card.width + 0.5,
          );
        }
        await expect(item.locator('.package')).toBeVisible();
      }
      await expectSameSquares(dialog.locator('.item .art app-tv-app-icon'));
      const overflow = await dialog
        .locator('.body')
        .evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow, 'sem rolagem horizontal no painel').toBeLessThanOrEqual(0);

      // Busca pelo nome, ordem, renomear (o ícone aparece no campo) e tirar do controle.
      await dialog.getByRole('searchbox', { name: 'Buscar app' }).fill('spot');
      await expect(dialog.locator('.item .name')).toHaveText(['Spotify']);
      await expect(items.first().locator('img')).toHaveCount(1);
      await button(dialog, 'Renomear Spotify').click();
      const head = dialog.locator('.edit-head');
      await expect(head.locator('img')).toHaveCount(1);
      await expect(head.locator('.edit-name')).toHaveText('Spotify');
      await expect.poll(() => imageLoaded(head.locator('img'))).toBe(true);
      await dialog.getByRole('button', { name: 'Cancelar' }).click();
      await expect(button(dialog, 'Renomear Spotify')).toBeFocused();
      await button(dialog, 'Tirar Spotify do controle').click();
      await expect(button(dialog, 'Fixar Spotify no controle')).toBeVisible();
      await expectNoHorizontalScroll(page);
    });
  });

  test('os ícones grandes ficam numa chave só deles e o estado guardado continua pequeno', async ({
    page,
  }) => {
    tv.shortcuts = iconShortcuts();
    await openTv(page);
    const stored = await page.evaluate(() => {
      // As duas chaves são por conta: o sufixo é a conta da sessão aberta.
      const account = encodeURIComponent(localStorage.getItem('uniover.account-id') ?? '');
      return {
        state: localStorage.getItem(`uniover.tv.last-state.${account}`) ?? '',
        icons: JSON.parse(
          localStorage.getItem(`uniover.tv.app-icons.${account}`) ?? '{}',
        ) as Record<string, string>,
      };
    });
    expect(stored.state).not.toContain('data:image');
    expect(stored.state.length).toBeLessThan(5_000);
    expect(Object.keys(stored.icons)).toHaveLength(4);
    expect(stored.icons[tv.shortcuts[1].id]).toBe(ICONS.square);
  });

  test('100 ícones de ~44 mil caracteres: a lista abre, rola sem travar e o que se guarda tem teto', async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    tv.shortcuts = Array.from({ length: 100 }, (_, index) => ({
      id: `00000000-0000-4000-8000-00000000${String(1000 + index)}`,
      position: index + 1,
      package: `exemplo.pacote.app${index + 1}`,
      tvLabel: `Aplicativo ${index + 1}`,
      customLabel: null,
      enabled: true,
      installed: true,
      iconDataUri: toDataUri(noisyIcon(index)),
    }));
    const chars = tv.shortcuts.reduce((sum, s) => sum + (s.iconDataUri?.length ?? 0), 0);
    expect(chars, 'ícones de teste perto do teto').toBeGreaterThan(4_000_000);

    await openTv(page);
    await expect(page.locator('.shortcuts .shortcut')).toHaveCount(100);
    await expectNoHorizontalScroll(page);
    await expectNoVerticalScroll(page);

    await openApps(page);
    const dialog = appsDialog(page);
    await expect(dialog.locator('.item')).toHaveCount(100);
    await settleMotion(page);

    // Rola a lista inteira, um passo por quadro, e mede o maior intervalo entre dois quadros seguidos.
    const frames = await dialog.locator('.body').evaluate(async (body) => {
      const gaps: number[] = [];
      let last = performance.now();
      const started = last;
      while (body.scrollTop + body.clientHeight < body.scrollHeight - 1) {
        body.scrollTop += 360;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const now = performance.now();
        gaps.push(now - last);
        last = now;
      }
      return {
        worst: Math.max(0, ...gaps),
        steps: gaps.length,
        total: performance.now() - started,
      };
    });
    console.log(
      `rolagem de 100 ícones (${info.project.name}): ${frames.steps} passos em ${Math.round(frames.total)} ms, pior quadro ${Math.round(frames.worst)} ms`,
    );
    expect(frames.worst, 'maior intervalo entre quadros durante a rolagem').toBeLessThan(1_000);
    const lastItem = dialog.locator('.item').last();
    await expect.poll(() => imageLoaded(lastItem.locator('img')), { timeout: 15_000 }).toBe(true);

    // O que o navegador guarda: ícones só até o teto, e o estado intacto e pequeno.
    const stored = await page.evaluate(() => {
      const account = encodeURIComponent(localStorage.getItem('uniover.account-id') ?? '');
      const icons = JSON.parse(
        localStorage.getItem(`uniover.tv.app-icons.${account}`) ?? '{}',
      ) as Record<string, string>;
      return {
        iconChars: Object.values(icons).reduce((sum, uri) => sum + uri.length, 0),
        iconCount: Object.keys(icons).length,
        stateChars: (localStorage.getItem(`uniover.tv.last-state.${account}`) ?? '').length,
      };
    });
    expect(stored.iconChars).toBeLessThanOrEqual(1_000_000);
    expect(stored.iconCount).toBeGreaterThan(0);
    expect(stored.stateChars).toBeGreaterThan(0);
    expect(stored.stateChars).toBeLessThan(30_000);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`fileira e painel Apps com ícone, banner e sem ícone passam no axe, com letra AA e prints, no tema ${scheme}`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      tv.shortcuts = iconShortcuts();
      await openTv(page);
      const chips = page.locator('.shortcuts .shortcut');
      for (const index of [0, 1, 2]) {
        await expect.poll(() => imageLoaded(chips.nth(index).locator('img'))).toBe(true);
      }
      await expect(chips.nth(5).locator('.fallback')).toBeVisible();
      const print = (scene: string) =>
        screenshot(page, `test-results/tv-icons-${scene}-${scheme}-${info.project.name}.png`);

      await print('row');
      await expectNoSeriousViolations(page);
      await page.locator('.shortcuts').evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
      await page.waitForTimeout(200);
      await print('row-end');

      const ratios = await fallbackContrasts(page);
      expect(ratios.length, 'azulejos de reserva na fileira').toBe(3);
      for (const ratio of ratios)
        expect(ratio, `contraste da letra (${scheme})`).toBeGreaterThanOrEqual(4.5);

      // Atrás de um ícone de desenho solto (fundo transparente) há o mesmo neutro claro nos dois temas, para ele não sumir
      // no escuro. O ícone que é uma placa de uma cor (o banner preto, o quadrado) leva a cor das próprias bordas, e o
      // neutro não aparece nele.
      const neutral = /238,\s*242,\s*238/;
      const backdrop = (index: number) =>
        chips
          .nth(index)
          .locator('app-tv-app-icon')
          .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(await backdrop(2), 'desenho solto: o neutro claro').toMatch(neutral);
      await expect
        .poll(() => backdrop(0), { message: 'banner preto: a cor da borda' })
        .not.toMatch(neutral);
      await expect
        .poll(() => backdrop(1), { message: 'quadrado: a cor da borda' })
        .not.toMatch(neutral);

      await openApps(page);
      const dialog = appsDialog(page);
      await expect(dialog.locator('.item')).toHaveCount(6);
      for (const index of [0, 1, 2]) {
        await expect
          .poll(() => imageLoaded(dialog.locator('.item').nth(index).locator('img')))
          .toBe(true);
      }
      // As imagens do painel carregam perto da tela: espera a quebrada cair no azulejo antes de medir.
      await expect
        .poll(async () => (await fallbackContrasts(page)).length)
        .toBeGreaterThanOrEqual(6);
      for (const ratio of await fallbackContrasts(page)) {
        expect(ratio, `contraste da letra no painel (${scheme})`).toBeGreaterThanOrEqual(4.5);
      }
      await settleMotion(page);
      await print('apps-grid');
      await expectNoSeriousViolations(page);
      await expectNoHorizontalScroll(page);

      await button(dialog, 'Editar').click();
      await expect(dialog.getByRole('heading', { level: 3, name: 'Todos os apps' })).toBeVisible();
      await settleMotion(page);
      await print('apps-edit');
      await expectNoSeriousViolations(page);
      await expectNoHorizontalScroll(page);

      await button(dialog, 'Renomear CineVS').click();
      await expect(dialog.locator('.edit-head img')).toHaveCount(1);
      await settleMotion(page);
      await print('apps-rename');
      await expectNoSeriousViolations(page);
      await dialog.getByRole('button', { name: 'Cancelar' }).click();

      // Tirar um app do controle e voltar: as duas seções, com o de fora igual aos outros.
      await button(dialog, 'Tirar Atalho 5 do controle').click();
      await expect(button(dialog, 'Fixar Atalho 5 no controle')).toBeVisible();
      await button(dialog, 'Concluir').click();
      await expect(
        dialog.getByRole('heading', { level: 3, name: 'Fora do controle' }),
      ).toBeVisible();
      await settleMotion(page);
      await print('apps-sections');
      await expectNoSeriousViolations(page);

      await dialog.getByRole('searchbox', { name: 'Buscar app' }).fill('o');
      await expect(dialog.getByRole('heading', { level: 3 })).toHaveCount(0);
      await settleMotion(page);
      await print('apps-search');
      await expectNoSeriousViolations(page);
      await dialog.getByRole('searchbox', { name: 'Buscar app' }).fill('');

      // Sem lista: o estado vazio com o botão que pede a lista à TV.
      await emitSse(page, 'tv.shortcuts', []);
      await expect(dialog.getByText('Ainda não temos a lista de apps da TV')).toBeVisible();
      await settleMotion(page);
      await print('apps-empty');
      await expectNoSeriousViolations(page);

      // Fechado o painel, a fileira vazia mostra as sugestões no lugar dos azulejos.
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('.shortcuts .shortcut.suggestion').first()).toBeVisible();
      await print('row-empty');
      await expectNoSeriousViolations(page);
    });
  }
});
