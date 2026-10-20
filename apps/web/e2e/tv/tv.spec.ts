import AxeBuilder from '@axe-core/playwright';
import { Locator, Page } from '@playwright/test';
import { IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import {
  HOT_STATE,
  MockTvState,
  SHORTCUTS,
  TvMock,
  emitSse,
  failSse,
  installFakeEventSource,
  mockTvApi,
  sseUrls,
} from './tv-mock';

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

const appsDialog = (page: Page) => page.getByRole('dialog', { name: 'Apps da TV' });
const keyboardDialog = (page: Page) => page.getByRole('dialog', { name: 'Teclado' });
const keyboardField = (page: Page) => page.getByLabel('Texto para a TV');

async function openApps(page: Page) {
  await button(page, 'Apps da TV').click();
  await expect(appsDialog(page)).toBeVisible();
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
    await expect(button(page, 'Apps da TV')).toBeVisible();

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
    await expect(button(page, 'Apps da TV')).toBeVisible();
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
      'Apps da TV',
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

  test('os botões de baixo cresceram: redondos maiores e pílulas que não ficaram mais estreitas', async ({
    page,
  }, info) => {
    await openTv(page);
    // Medidas da versão anterior nestes dois aparelhos (largura da pílula e diâmetro do botão redondo, em px).
    const before = {
      'iphone-12': { pill: 54.4, round: 52.8 },
      's23-fe': { pill: 65.6, round: 52.4 },
    }[info.project.name as 'iphone-12' | 's23-fe'];
    const round = (await button(page, 'Voltar').boundingBox())!;
    const pill = (await page.getByRole('group', { name: 'Volume' }).boundingBox())!;
    const channel = (await page.getByRole('group', { name: 'Canal' }).boundingBox())!;
    expect(round.width, 'botão redondo é círculo').toBeCloseTo(round.height, 0);
    expect(round.width, 'botão redondo maior que antes').toBeGreaterThanOrEqual(before.round + 3);
    expect(pill.width, 'pílula de volume não encolheu').toBeGreaterThanOrEqual(before.pill - 0.6);
    expect(channel.width, 'pílula de canal não encolheu').toBeGreaterThanOrEqual(before.pill - 0.6);
    expect(pill.height, 'pílula de volume não ficou mais baixa').toBeGreaterThanOrEqual(127);
    // Cada botão da pílula continua sendo um alvo confortável para o polegar.
    for (const name of ['Aumentar o volume', 'Diminuir o volume']) {
      const box = (await button(page, name).boundingBox())!;
      expect(box.height, name).toBeGreaterThanOrEqual(46);
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

test.describe('controle: fileira de atalhos e chip Apps', () => {
  test('os atalhos são chips que abrem o app ao toque, como "Atalho n" quando nada os nomeia', async ({
    page,
  }) => {
    await openTv(page);
    for (const n of [1, 2, 3]) await expect(button(page, `Atalho ${n}`)).toBeVisible();
    // O pacote não aparece na tela de controle.
    await expect(page.getByText('exemplo.pacote')).toHaveCount(0);

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

  test('o nome do chip é o do dono, depois o que o agente publica para o app, só então "Atalho n"', async ({
    page,
  }) => {
    tv.shortcuts = tv.shortcuts.map((s) => ({
      ...s,
      customLabel: s.position === 1 ? 'Sala' : null,
      tvLabel: s.position <= 2 ? ['YouTube', 'Spotify'][s.position - 1] : null,
    }));
    await openTv(page);
    await expect(page.locator('.shortcuts .shortcut')).toHaveText(['Sala', 'Spotify', 'Atalho 3']);

    // O mesmo nome na grade e na lista do painel Apps, e a busca acha pelo nome que o agente publicou.
    await openApps(page);
    const names = appsDialog(page).locator('.item .name');
    await expect(names).toHaveText(['Sala', 'Spotify', 'Atalho 3']);
    await appsDialog(page).getByRole('button', { name: 'Lista', exact: true }).click();
    await expect(names).toHaveText(['Sala', 'Spotify', 'Atalho 3']);
    await appsDialog(page).getByRole('searchbox', { name: 'Buscar app' }).fill('spot');
    await expect(names).toHaveText(['Spotify']);
    await button(appsDialog(page), 'Renomear Spotify').click();
    await expect(appsDialog(page).getByLabel('Nome do atalho')).toHaveValue('');
  });

  test('os chips seguem a ordem de posição da API e o chip Apps fica fixo à esquerda', async ({
    page,
  }) => {
    tv.shortcuts = [3, 1, 2].map((position) => ({
      ...tv.shortcuts[position - 1],
      customLabel: `App ${position}`,
    }));
    await openTv(page);
    const chips = page.locator('.shortcuts .shortcut');
    // A API entrega por posição e o app mantém essa ordem (aqui a lista chega embaralhada e sai por posição).
    await expect(chips).toHaveText(['App 1', 'App 2', 'App 3']);
    const apps = (await button(page, 'Apps da TV').boundingBox())!;
    const first = (await chips.first().boundingBox())!;
    expect(apps.x).toBeLessThan(first.x);
  });

  test('sem atalhos não há texto de erro: só o chip Apps', async ({ page }) => {
    tv.shortcuts = [];
    await openTv(page);
    await expect(button(page, 'Apps da TV')).toBeVisible();
    await expect(page.locator('.shortcuts .shortcut')).toHaveCount(0);
    await expect(page.getByText(/sem atalhos/i)).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Veja a aba Apps/ })).toHaveCount(0);
    await expectNoVerticalScroll(page);
  });

  test('muitos atalhos rolam na faixa, sem rolagem da tela e com o chip Apps parado', async ({
    page,
  }) => {
    tv.shortcuts = Array.from({ length: 9 }, (_, index) => ({
      id: `00000000-0000-4000-8000-0000000000${String(index + 10)}`,
      position: index + 1,
      package: `exemplo.pacote.app${index + 1}`,
      tvLabel: null,
      customLabel: `Aplicativo número ${index + 1}`,
      enabled: true,
    }));
    await openTv(page);
    const before = (await button(page, 'Apps da TV').boundingBox())!;
    await page.locator('.shortcuts').evaluate((el) => el.scrollTo({ left: 400 }));
    expect(await button(page, 'Apps da TV').boundingBox()).toEqual(before);
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

  test('sem agente configurado o ponto pede atenção e a tela diz o motivo', async ({ page }) => {
    // Sem agente configurado a API informa agente fora do ar, e o aquecer volta 503 com o tipo próprio.
    tv.state = { ...HOT_STATE, agentOnline: false, connection: 'disconnected', volume: null };
    tv.wakeFailure = { status: 503, kind: 'agent-not-configured' };
    await openTv(page);
    await expect(statusDot(page, 'Sem agente configurado')).toHaveAttribute(
      'data-phase',
      'attention',
    );
    await expect(
      page.getByText('Nenhum agente foi configurado para controlar a TV.').first(),
    ).toBeVisible();
    await expect(button(page, 'OK')).toBeDisabled();
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
    await page.waitForTimeout(250); // fim da animação de entrada
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
    await page.waitForTimeout(250);
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

  test('o foco entra no painel, fica preso nele e volta ao botão que o abriu', async ({ page }) => {
    await openTv(page);
    const chip = button(page, 'Apps da TV');
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(appsDialog(page)).toBeVisible();
    await expect(appsDialog(page).locator(':focus')).toHaveCount(1);

    // Tab nunca chega a um controle de trás do painel (o resto da tela fica inerte).
    for (let step = 0; step < 14; step++) {
      await page.keyboard.press('Tab');
      const behind = await page.evaluate(
        () => document.activeElement?.closest('app-tv-control, header.head') ?? null,
      );
      expect(behind, `Tab ${step + 1}`).toBeNull();
    }

    await page.keyboard.press('Escape');
    await expect(appsDialog(page)).toHaveCount(0);
    await expect(chip).toBeFocused();

    const keyboard = button(page, 'Teclado');
    await keyboard.focus();
    await page.keyboard.press('Enter');
    await expect(keyboardDialog(page)).toBeVisible();
    await expect(keyboardField(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(keyboardDialog(page)).toHaveCount(0);
    await expect(keyboard).toBeFocused();
  });

  test('a animação de entrada some para quem pediu menos movimento', async ({ page }) => {
    await openTv(page);
    await openApps(page);
    const animation = () =>
      appsDialog(page)
        .locator('.card')
        .evaluate((el) => getComputedStyle(el).animationName);
    expect(await animation()).not.toBe('none');
    await page.keyboard.press('Escape');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApps(page);
    expect(await animation()).toBe('none');
  });
});

test.describe('painel Apps', () => {
  test('lista os atalhos, abre, renomeia, esconde e atualiza a lista', async ({ page }, info) => {
    await openTv(page);
    await openApps(page);
    const dialog = appsDialog(page);
    await expect(dialog.getByRole('heading', { level: 2, name: 'Apps da TV' })).toBeVisible();
    await expect(dialog.locator('.item .name')).toHaveText(['Atalho 1', 'Atalho 2', 'Atalho 3']);
    await expect(dialog.locator('.item .package').first()).toHaveText('exemplo.pacote.app1');
    await expectNoHorizontalScroll(page);
    await page.waitForTimeout(250);
    await screenshot(page, `test-results/tv-apps-grid-${info.project.name}.png`);
    await expectNoSeriousViolations(page);

    // Renomear (a grade deixa a linha do campo ocupar a largura toda).
    await button(dialog, 'Renomear Atalho 2').click();
    await dialog.getByLabel('Nome do atalho').fill('Sala');
    await dialog.getByRole('button', { name: 'Salvar' }).click();
    await expect(dialog.locator('.item .name').nth(1)).toHaveText('Sala');
    expect(tv.requests.find((r) => r.method === 'PATCH')?.body).toEqual({
      customLabel: 'Sala',
      enabled: null,
    });

    await button(dialog, 'Ocultar Atalho 3').click();
    await expect(button(dialog, 'Mostrar Atalho 3')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Atalho 3 / })).toBeDisabled();

    await dialog.getByRole('button', { name: 'Atualizar lista' }).click();
    await expect.poll(() => tv.count('/shortcuts/refresh')).toBe(1);
    // Com o painel aberto, o aviso aparece dentro dele (o aviso da tela ficaria atrás do fundo).
    await expect(dialog.getByText('Lista de apps atualizada.')).toBeVisible();

    // Abrir um app: o pedido sai, o painel fecha e o aviso aparece na tela do controle.
    await dialog.getByRole('button', { name: /^Atalho 1 / }).click();
    await expect.poll(() => tv.count(`/shortcuts/${tv.shortcuts[0].id}/launch`)).toBe(1);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Atalho 1 aberto na TV.')).toBeVisible();

    // O atalho escondido some da fileira de cima; o renomeado aparece com o nome novo.
    await expect(button(page, 'Atalho 1')).toBeVisible();
    await expect(button(page, 'Sala')).toBeVisible();
    await expect(button(page, 'Atalho 3')).toHaveCount(0);
  });

  test('busca por texto, grade e lista', async ({ page }, info) => {
    tv.shortcuts = tv.shortcuts.map((s) => ({
      ...s,
      customLabel: ['Câmera da sala', 'Filmes', 'Jogos'][s.position - 1],
    }));
    await openTv(page);
    await openApps(page);
    const dialog = appsDialog(page);
    const names = dialog.locator('.item .name');
    await expect(names).toHaveText(['Câmera da sala', 'Filmes', 'Jogos']);

    const search = dialog.getByRole('searchbox', { name: 'Buscar app' });
    await search.fill('CAMERA');
    await expect(names).toHaveText(['Câmera da sala']);
    await search.fill('pacote.app3');
    await expect(names).toHaveText(['Jogos']);
    await search.fill('zzz');
    await expect(dialog.getByText('Nenhum app encontrado para essa busca.')).toBeVisible();
    await search.fill('');
    await expect(names).toHaveCount(3);

    // Lista em vez de grade, e a escolha fica para a próxima vez.
    await dialog.getByRole('button', { name: 'Lista', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Lista', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(dialog.locator('.list')).toHaveAttribute('data-view', 'list');
    await page.waitForTimeout(250);
    await screenshot(page, `test-results/tv-apps-list-${info.project.name}.png`);
    await expectNoSeriousViolations(page);
    await page.keyboard.press('Escape');
    await openApps(page);
    await expect(appsDialog(page).locator('.list')).toHaveAttribute('data-view', 'list');

    // Na lista, abrir um app continua valendo.
    await appsDialog(page)
      .getByRole('button', { name: /^Filmes / })
      .click();
    await expect.poll(() => tv.count(`/shortcuts/${tv.shortcuts[1].id}/launch`)).toBe(1);
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
    await page.waitForTimeout(250);
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
    // Digitação seguida: uma pausa só no fim, então um único envio com o texto completo.
    await page.keyboard.type('batman', { delay: 40 });
    await expect.poll(() => texts()).toEqual(['batman']);
    await expect(page.getByText('Texto na TV.')).toBeVisible();
    await page.waitForTimeout(700);
    expect(texts()).toEqual(['batman']);
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

  test('o texto vazio nunca é enviado', async ({ page }) => {
    await openTv(page);
    await openKeyboard(page);
    const field = keyboardField(page);
    await field.fill('bat');
    await expect.poll(() => texts()).toEqual(['bat']);
    await field.fill('');
    await page.waitForTimeout(700);
    expect(texts()).toEqual(['bat']);
    expect(tv.requests.some((r) => r.path === '/text' && !r.body?.['text'])).toBe(false);
  });

  test('Limpar esvazia só o campo do celular e Fechar fecha o painel, enviando o que faltava', async ({
    page,
  }) => {
    await openTv(page);
    await openKeyboard(page);
    const field = keyboardField(page);
    await field.fill('bat');
    await expect.poll(() => texts()).toEqual(['bat']);
    await button(keyboardDialog(page), 'Limpar').click();
    await expect(field).toHaveValue('');
    await page.waitForTimeout(600);
    expect(texts()).toEqual(['bat']);

    await field.fill('x');
    await button(keyboardDialog(page), 'Fechar').click();
    await expect(keyboardDialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/tv$/);
    await expect(button(page, 'Teclado')).toBeFocused();
    // O que ainda estava dentro da pausa de digitação não se perde ao fechar.
    await expect.poll(() => texts()).toEqual(['bat', 'x']);
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
      await page.waitForTimeout(250);
      await screenshot(page, `test-results/tv-apps-${scheme}-${info.project.name}.png`);
      await expectNoSeriousViolations(page);
      await page.keyboard.press('Escape');

      await openKeyboard(page);
      await page.waitForTimeout(250);
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

  test('o foco do teclado é visível nos botões, nos setores do anel e no chip Apps', async ({
    page,
  }) => {
    await openTv(page);
    await button(page, 'Para cima').focus();
    const outline = await button(page, 'Para cima')
      .locator('.glyph')
      .evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe('solid');
    for (const name of ['Menu', 'Apps da TV', 'Atalho 1']) {
      await button(page, name).focus();
      const style = await button(page, name).evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(style, name).toBe('solid');
    }
  });
});

/** Caixa de cada elemento fixo do controle (tudo que não é o palco que troca de página). */
async function fixedBoxes(page: Page) {
  const targets: [string, Locator][] = [
    ['apps', button(page, 'Apps da TV')],
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
        'Apps da TV',
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
        await page.waitForTimeout(250);
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
