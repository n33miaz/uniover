import AxeBuilder from '@axe-core/playwright';
import { Locator, Page } from '@playwright/test';
import { IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import {
  HOT_STATE,
  MockTvState,
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
/** As duas páginas do palco (direções e números) ficam no DOM; o resto do controle é fixo, fora delas. */
const secondPage = (page: Page) => page.locator('.panel').nth(1);

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

test.describe('controle: primeira página', () => {
  test('cabe na tela sem rolagem e mostra anel, pílulas, botões redondos e estado', async ({
    page,
  }, info) => {
    await openTv(page);
    await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
    await expect(page.getByText('conectada', { exact: true })).toBeVisible();
    await expect(page.getByText('hiberna em 5 min')).toBeVisible();
    await expect(page.getByRole('img', { name: 'Volume 22' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Atalho 1' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Abas do módulo' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Controle' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await expectNoHorizontalScroll(page);
    await expectNoVerticalScroll(page);
    await screenshot(page, `test-results/tv-control-${info.project.name}.png`);
    await expectNoSeriousViolations(page);
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
      'Desligar a TV',
      'Trocar para o modo touchpad',
      'Atalho 1',
      'Página 1 de 2',
      'Página 2 de 2',
    ];
    for (const name of targets) await expectTargetSize(button(page, name));
    await expectTargetSize(button(page, 'OK'));
    await expectTargetSize(page.getByRole('link', { name: 'Teclado', exact: true }).first());
    // O setor do anel é um triângulo na caixa do anel inteiro; o ícone dele é o alvo visível.
    for (const name of Object.keys(RING_SPOT)) {
      await expectTargetSize(button(page, name).locator('.glyph'));
      await expectTargetSize(button(page, name));
    }
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

  test('atalhos aparecem como "Atalho n", sem nome de app, e abrem pela API', async ({ page }) => {
    await openTv(page);
    for (const n of [1, 2, 3]) await expect(button(page, `Atalho ${n}`)).toBeVisible();
    // O rótulo que a TV informou e o pacote não aparecem na tela de controle.
    await expect(page.getByText('Rótulo da TV')).toHaveCount(0);
    await expect(page.getByText('exemplo.pacote')).toHaveCount(0);

    await button(page, 'Atalho 2').click();
    await expect.poll(() => tv.count(`/shortcuts/${tv.shortcuts[1].id}/launch`)).toBe(1);

    // Um nome dado pelo dono, chegando pelo fluxo, passa a valer.
    await emitSse(
      page,
      'tv.shortcuts',
      tv.shortcuts.map((s) => (s.position === 2 ? { ...s, customLabel: 'Sala' } : s)),
    );
    await expect(button(page, 'Sala')).toBeVisible();
    await expect(button(page, 'Atalho 2')).toHaveCount(0);
  });

  test('sem atalhos a tela diz onde conseguir', async ({ page }) => {
    tv.shortcuts = [];
    await openTv(page);
    const hint = page.getByRole('link', { name: 'Sem atalhos ainda. Veja a aba Apps.' });
    await expect(hint).toBeVisible();
    await hint.click();
    await expect(page).toHaveURL(/\/tv\/apps$/);
  });
});

test.describe('controle: segunda página e touchpad', () => {
  test('a segunda página tem os números e a origem e acompanha os pontos', async ({
    page,
  }, info) => {
    await openTv(page);
    const second = button(page, 'Página 2 de 2');
    await second.click();
    await expect(second).toHaveAttribute('aria-current', 'true');
    await expect(button(page, 'Página 1 de 2')).not.toHaveAttribute('aria-current', 'true');
    await expect(button(secondPage(page), 'Número 5')).toBeInViewport({ ratio: 1 });
    // A rolagem é suave: espera o encaixe terminar antes de medir e de tirar o print.
    await expect
      .poll(() => page.locator('.pager').evaluate((el) => Math.abs(el.scrollLeft - el.clientWidth)))
      .toBeLessThanOrEqual(1);
    await expectNoHorizontalScroll(page);
    await expectNoVerticalScroll(page);
    await screenshot(page, `test-results/tv-page2-${info.project.name}.png`);
    await expectNoSeriousViolations(page);

    for (const digit of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      await expectTargetSize(button(secondPage(page), `Número ${digit}`));
      const before = tv.keysSent().length;
      await button(secondPage(page), `Número ${digit}`).click();
      await expect.poll(() => tv.keysSent().slice(before)).toEqual([`NUM_${digit}`]);
    }
    await expectTargetSize(button(secondPage(page), 'Origem'));
    const before = tv.keysSent().length;
    await button(secondPage(page), 'Origem').click();
    await expect.poll(() => tv.keysSent().slice(before)).toEqual(['INPUT']);

    await button(page, 'Página 1 de 2').click();
    await expect(button(page, 'Página 1 de 2')).toHaveAttribute('aria-current', 'true');
    await expect(button(page, 'OK')).toBeInViewport({ ratio: 1 });
  });

  test('rolar o carrossel para a segunda página marca o ponto', async ({ page }) => {
    await openTv(page);
    await page.locator('.pager').evaluate((el) => el.scrollTo({ left: el.clientWidth }));
    await expect(button(page, 'Página 2 de 2')).toHaveAttribute('aria-current', 'true');
    await expectNoHorizontalScroll(page);
  });

  test('deslizar com o dedo sobre um botão vira a página e não aperta tecla', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'o gesto de toque sintético só existe no Chromium');
    await openTv(page);
    const ok = (await button(page, 'OK').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const x0 = ok.x + ok.width / 2;
    const y0 = ok.y + ok.height / 2;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: x0, y: y0 }],
    });
    for (let step = 1; step <= 10; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x0 - step * 25, y: y0 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(button(page, 'Página 2 de 2')).toHaveAttribute('aria-current', 'true');
    expect(tv.keysSent()).toEqual([]);
  });

  test('touchpad: deslizar manda setas, toque curto manda OK, toque longo não manda nada', async ({
    page,
  }, info) => {
    await openTv(page);
    await button(page, 'Trocar para o modo touchpad').click();
    const pad = page.locator('app-touchpad-surface .pad');
    await expect(pad).toBeVisible();
    await expect(page.getByText('Deslize para mover · toque para OK')).toBeVisible();
    await expect(button(page, 'Touchpad')).toHaveAttribute('aria-pressed', 'true');
    await expect(button(page, 'Botões')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('group', { name: 'Setas de direção' })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectNoVerticalScroll(page);
    await screenshot(page, `test-results/tv-touchpad-${info.project.name}.png`);
    await expectNoSeriousViolations(page);

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

    // Voltar, início e volume continuam à mão.
    const row = tv.keysSent().length;
    await button(page, 'Voltar').click();
    await button(page, 'Aumentar o volume').click();
    await expect.poll(() => tv.keysSent().slice(row)).toEqual(['BACK', 'VOLUME_UP']);

    // De volta a "Botões": o anel reaparece.
    await button(page, 'Botões').click();
    await expect(page.getByRole('group', { name: 'Setas de direção' })).toBeVisible();
    await expect(button(page, 'Trocar para o modo touchpad')).toBeVisible();
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

  test('"controle dormindo" nunca vira "TV desligada"', async ({ page }) => {
    await openTv(page);
    await sendState(page, { connection: 'hibernating' });
    await expect(page.getByText('controle dormindo', { exact: true })).toBeVisible();
    await expect(page.getByText('hiberna em')).toHaveCount(0);
    await expect(page.getByText(/TV desligada/i)).toHaveCount(0);
    // Dormindo, os botões seguem valendo: o primeiro comando reconecta.
    await expect(button(page, 'OK')).toBeEnabled();
    await expectNoSeriousViolations(page);
  });

  test('agente desligado desabilita os botões e explica', async ({ page }, info) => {
    await openTv(page);
    await sendState(page, { agentOnline: false, connection: 'disconnected', volume: null });
    await expect(page.getByText('agente desligado', { exact: true })).toBeVisible();
    await expect(
      page.getByText('O agente da TV está desligado, então os botões não funcionam agora.'),
    ).toBeVisible();
    await expect(button(page, 'OK')).toBeDisabled();
    await expect(button(page, 'Aumentar o volume')).toBeDisabled();
    await expect(button(page, 'Desligar a TV')).toBeDisabled();
    await expect(page.getByRole('img', { name: 'Volume desconhecido' })).toBeVisible();
    await expect(page.getByText(/TV desligada/i)).toHaveCount(0);
    await screenshot(page, `test-results/tv-agent-off-${info.project.name}.png`);
    await expectNoVerticalScroll(page);
    await expectNoSeriousViolations(page);

    // Quando o agente volta, o fluxo reabilita tudo.
    await sendState(page, {});
    await expect(button(page, 'OK')).toBeEnabled();
    await expect(page.getByText('conectada', { exact: true })).toBeVisible();
  });

  test('o vigia que religou o serviço aparece com a hora', async ({ page }) => {
    await openTv(page);
    await emitSse(page, 'tv.watchdog', {
      kind: 'repaired',
      severity: 'info',
      detail: '',
      attempts: 1,
      at: '2026-10-19T14:02:00Z',
    });
    await expect(page.getByText(/controle religado às \d{2}:\d{2}/)).toBeVisible();
  });

  test('se o fluxo cai, mostra "reconectando" e reabre sozinho', async ({ page }) => {
    await openTv(page);
    await failSse(page);
    await expect(page.getByText('reconectando…')).toBeVisible();
    await expect.poll(() => sseUrls(page)).toHaveLength(2);
    await expect(page.getByText('reconectando…')).toHaveCount(0);
  });

  test('sem rede, mostra o último estado com a hora e desabilita os botões', async ({
    page,
    context,
  }, info) => {
    await openTv(page);
    await context.setOffline(true);
    await expect(page.getByText('sem rede', { exact: true })).toBeVisible();
    await expect(page.getByText(/visto às \d{2}:\d{2} · conectada/)).toBeVisible();
    await expect(page.getByText(/Sem rede: o controle precisa de internet/)).toBeVisible();
    await expect(button(page, 'OK')).toBeDisabled();
    await expect(button(page, 'Desligar a TV')).toBeDisabled();
    // A faixa "Sem conexão" da casca soma a própria altura à do documento, em qualquer tela: a rolagem vertical
    // só é conferida com rede.
    await screenshot(page, `test-results/tv-offline-${info.project.name}.png`);

    await context.setOffline(false);
    await expect(button(page, 'OK')).toBeEnabled();
    await expect(page.getByText('sem rede', { exact: true })).toHaveCount(0);
  });

  test('sem agente configurado a tela diz o motivo', async ({ page }) => {
    // Sem agente configurado a API informa agente fora do ar, e o aquecer volta 503 com o tipo próprio.
    tv.state = { ...HOT_STATE, agentOnline: false, connection: 'disconnected', volume: null };
    tv.wakeFailure = { status: 503, kind: 'agent-not-configured' };
    await openTv(page);
    await expect(page.getByText('sem agente configurado', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Nenhum agente foi configurado para controlar a TV.'),
    ).toBeVisible();
    await expect(button(page, 'OK')).toBeDisabled();
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
    await expect(page.getByText('agente desligado', { exact: true })).toBeVisible();
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

test.describe('aba Apps', () => {
  test('lista os atalhos, abre, renomeia, esconde e atualiza a lista', async ({ page }, info) => {
    await openTv(page);
    await page.getByRole('link', { name: 'Apps', exact: true }).click();
    await expect(page).toHaveURL(/\/tv\/apps$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Apps da TV' })).toBeVisible();
    await expect(page.locator('.item .name')).toHaveText(['Atalho 1', 'Atalho 2', 'Atalho 3']);
    await expect(page.locator('.item .package').first()).toHaveText('exemplo.pacote.app1');
    await expectNoHorizontalScroll(page);
    await screenshot(page, `test-results/tv-apps-${info.project.name}.png`);
    await expectNoSeriousViolations(page);

    await page.getByRole('button', { name: /^Atalho 1 / }).click();
    await expect.poll(() => tv.count(`/shortcuts/${tv.shortcuts[0].id}/launch`)).toBe(1);

    await button(page, 'Renomear Atalho 2').click();
    await page.getByLabel('Nome do atalho').fill('Sala');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.locator('.item .name').nth(1)).toHaveText('Sala');
    expect(tv.requests.find((r) => r.method === 'PATCH')?.body).toEqual({
      customLabel: 'Sala',
      enabled: null,
    });

    await button(page, 'Ocultar Atalho 3').click();
    await expect(button(page, 'Mostrar Atalho 3')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Atalho 3 / })).toBeDisabled();

    await page.getByRole('button', { name: 'Atualizar lista' }).click();
    await expect.poll(() => tv.count('/shortcuts/refresh')).toBe(1);
    await expect(page.getByText('Lista de apps atualizada.')).toBeVisible();

    // O atalho escondido some do controle; o renomeado aparece com o nome novo.
    await page.getByRole('link', { name: 'Controle', exact: true }).click();
    await expect(button(page, 'Atalho 1')).toBeVisible();
    await expect(button(page, 'Sala')).toBeVisible();
    await expect(button(page, 'Atalho 3')).toHaveCount(0);
  });

  test('sem atalhos ainda, convida a atualizar a lista', async ({ page }) => {
    tv.shortcuts = [];
    await openTv(page, '/tv/apps');
    await expect(
      page.getByText(
        'Nenhum atalho ainda. Toque em Atualizar lista para a TV informar os apps instalados.',
      ),
    ).toBeVisible();
  });
});

test.describe('aba Teclado', () => {
  const openKeyboard = async (page: Page) => {
    await openTv(page, '/tv/teclado');
    await expect(page.getByLabel('Texto para a TV')).toBeVisible();
  };
  const texts = () => tv.requests.filter((r) => r.path === '/text').map((r) => r.body?.['text']);

  test('o texto vai para a TV enquanto se digita, sem Enviar nem OK, e o campo não limpa', async ({
    page,
  }, info) => {
    await openKeyboard(page);
    await expect(
      page.getByText('O texto é escrito no campo que estiver aberto na TV', { exact: false }),
    ).toBeVisible();
    await expect(button(page, 'Enviar')).toHaveCount(0);
    await expect(
      page.getByText('Para apagar tudo, use o botão de apagar da própria TV.', { exact: false }),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
    await screenshot(page, `test-results/tv-keyboard-${info.project.name}.png`);
    await expectNoSeriousViolations(page);

    const field = page.getByLabel('Texto para a TV');
    await field.focus();
    // Digitação seguida: uma pausa só no fim, então um único envio com o texto completo.
    await page.keyboard.type('batman', { delay: 40 });
    await expect.poll(() => texts()).toEqual(['batman']);
    await expect(page.getByText('Texto na TV.')).toBeVisible();
    await page.waitForTimeout(700);
    expect(texts()).toEqual(['batman']);
    await expect(field).toHaveValue('batman');
    await expect(page.getByText('6 / 200')).toBeVisible();
    await screenshot(page, `test-results/tv-keyboard-typed-${info.project.name}.png`);
    await expectNoSeriousViolations(page);
  });

  test('com pausas entre as letras o app manda o texto completo a cada pausa, nunca só o pedaço novo', async ({
    page,
  }) => {
    await openKeyboard(page);
    const field = page.getByLabel('Texto para a TV');
    await field.focus();
    for (const letter of ['b', 'a', 't']) {
      await page.keyboard.type(letter);
      await page.waitForTimeout(450);
    }
    expect(texts()).toEqual(['b', 'ba', 'bat']);
    // Apagar uma letra também sincroniza (o texto da TV passa a ser o do campo).
    await page.keyboard.press('Backspace');
    await expect.poll(() => texts()).toEqual(['b', 'ba', 'bat', 'ba']);
  });

  test('o texto vazio nunca é enviado: apagar tudo não manda nada e a nota fica à vista', async ({
    page,
  }) => {
    await openKeyboard(page);
    const field = page.getByLabel('Texto para a TV');
    await field.fill('bat');
    await expect.poll(() => texts()).toEqual(['bat']);
    await field.fill('');
    await page.waitForTimeout(700);
    expect(texts()).toEqual(['bat']);
    expect(tv.requests.some((r) => r.path === '/text' && !r.body?.['text'])).toBe(false);
    await expect(page.getByText('Texto vazio não é enviado.', { exact: false })).toBeVisible();
  });

  test('Limpar esvazia só o campo do celular e Voltar ao controle sai da aba', async ({ page }) => {
    await openKeyboard(page);
    const field = page.getByLabel('Texto para a TV');
    await field.fill('bat');
    await expect.poll(() => texts()).toEqual(['bat']);
    await button(page, 'Limpar').click();
    await expect(field).toHaveValue('');
    await page.waitForTimeout(600);
    expect(texts()).toEqual(['bat']);

    await field.fill('x');
    await button(page, 'Voltar ao controle').click();
    await expect(page).toHaveURL(/\/tv$/);
    // O que ainda estava dentro da pausa de digitação não se perde ao sair.
    await expect.poll(() => texts()).toEqual(['bat', 'x']);
  });

  test('recusa mais de 200 caracteres: nada é enviado enquanto passar do limite', async ({
    page,
  }) => {
    await openKeyboard(page);
    const field = page.getByLabel('Texto para a TV');
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
    await openKeyboard(page);
    const field = page.getByLabel('Texto para a TV');
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

  test('o botão de teclado do controle leva até a aba', async ({ page }) => {
    await openTv(page);
    await page.getByRole('link', { name: 'Teclado', exact: true }).first().click();
    await expect(page).toHaveURL(/\/tv\/teclado$/);
  });
});

test.describe('acessibilidade e tema', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`as três abas e o touchpad passam no axe no tema ${scheme}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openTv(page);
      await sendState(page, { connection: 'hibernating' });
      await expect(page.getByText('controle dormindo', { exact: true })).toBeVisible();
      await screenshot(page, `test-results/tv-control-${scheme}-${info.project.name}.png`);
      await expectNoSeriousViolations(page);

      await button(page, 'Trocar para o modo touchpad').click();
      await expectNoSeriousViolations(page);

      await page.getByRole('link', { name: 'Apps', exact: true }).click();
      await expect(page.locator('.item')).toHaveCount(3);
      await expectNoSeriousViolations(page);

      await page.getByRole('link', { name: 'Teclado', exact: true }).click();
      await expect(page.getByLabel('Texto para a TV')).toBeVisible();
      await expectNoSeriousViolations(page);
    });
  }

  test('o foco do teclado é visível nos botões e nos setores do anel', async ({ page }) => {
    await openTv(page);
    await button(page, 'Para cima').focus();
    const outline = await button(page, 'Para cima')
      .locator('.glyph')
      .evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe('solid');
    await button(page, 'Menu').focus();
    const menuOutline = await button(page, 'Menu').evaluate(
      (el) => getComputedStyle(el).outlineStyle,
    );
    expect(menuOutline).toBe('solid');
  });
});

/** Caixa de cada elemento fixo do controle (tudo que não é o palco que troca de página). */
async function fixedBoxes(page: Page) {
  const targets: [string, Locator][] = [
    ['atalho', button(page, 'Atalho 1')],
    ['touchpad', button(page, 'Trocar para o modo touchpad')],
    ['volume+', button(page, 'Aumentar o volume')],
    ['voltar', button(page, 'Voltar')],
    ['menu', button(page, 'Menu')],
    ['teclado', page.getByRole('link', { name: 'Teclado', exact: true }).first()],
    ['anterior', button(page, 'Anterior')],
    ['canal+', button(page, 'Próximo canal')],
    ['ponto 1', button(page, 'Página 1 de 2')],
    ['ponto 2', button(page, 'Página 2 de 2')],
    ['palco', page.locator('.viewport')],
  ];
  const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const [name, locator] of targets) {
    if ((await locator.count()) === 0) continue;
    boxes[name] = (await locator.boundingBox())!;
  }
  return boxes;
}

async function settlePage(page: Page, index: number) {
  await expect
    .poll(() =>
      page
        .locator('.pager')
        .evaluate((el, i) => Math.abs(el.scrollLeft - i * el.clientWidth), index),
    )
    .toBeLessThanOrEqual(1);
}

test.describe('controle: só o palco central troca de página', () => {
  test('atalhos, pílulas, botões redondos e pontos não saem do lugar ao trocar de página', async ({
    page,
  }, info) => {
    await openTv(page);
    const before = await fixedBoxes(page);
    await button(page, 'Página 2 de 2').click();
    await settlePage(page, 1);
    await screenshot(page, `test-results/tv-stage-numbers-${info.project.name}.png`);
    expect(await fixedBoxes(page)).toEqual(before);

    // Só o palco mudou de conteúdo: os números aparecem onde estava o anel.
    await expect(button(secondPage(page), 'Número 1')).toBeInViewport({ ratio: 1 });
    await expect(button(page, 'OK')).not.toBeInViewport();
    await button(page, 'Página 1 de 2').click();
    await settlePage(page, 0);
    expect(await fixedBoxes(page)).toEqual(before);
    await expect(button(page, 'OK')).toBeInViewport({ ratio: 1 });
  });

  test('as setas do teclado nos pontos trocam a página sem gesto', async ({ page }) => {
    await openTv(page);
    await button(page, 'Página 1 de 2').focus();
    await page.keyboard.press('ArrowRight');
    await settlePage(page, 1);
    await expect(button(page, 'Página 2 de 2')).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('ArrowLeft');
    await settlePage(page, 0);
    await expect(button(page, 'Página 1 de 2')).toHaveAttribute('aria-current', 'true');
  });

  test('o palco é focável e as setas do teclado rolam para a segunda página', async ({ page }) => {
    await openTv(page);
    const pager = page.getByRole('group', { name: 'Direções e teclado numérico' });
    await pager.focus();
    await expect(pager).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await settlePage(page, 1);
    await expect(button(page, 'Página 2 de 2')).toHaveAttribute('aria-current', 'true');
  });

  test('deslizar com o dedo sobre os botões de baixo não vira a página nem aperta tecla', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'o gesto de toque sintético só existe no Chromium');
    await openTv(page);
    const menu = (await button(page, 'Menu').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const x0 = menu.x + menu.width / 2;
    const y0 = menu.y + menu.height / 2;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: x0, y: y0 }],
    });
    for (let step = 1; step <= 10; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x0 - step * 20, y: y0 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(400);
    await expect(button(page, 'Página 1 de 2')).toHaveAttribute('aria-current', 'true');
    expect(tv.keysSent()).toEqual([]);
  });

  test('no touchpad a superfície fica no palco, com os botões fixos no mesmo lugar', async ({
    page,
  }, info) => {
    await openTv(page);
    const before = await fixedBoxes(page);
    await button(page, 'Trocar para o modo touchpad').click();
    await expect(page.locator('.panel').first().locator('app-touchpad-surface')).toBeVisible();
    const after = await fixedBoxes(page);
    // No lugar do botão "Touchpad" vêm os chips; o que está de baixo e o palco não mexem.
    for (const name of ['volume+', 'voltar', 'menu', 'teclado', 'anterior', 'canal+', 'palco']) {
      expect(after[name], name).toEqual(before[name]);
    }
    await button(page, 'Página 2 de 2').click();
    await settlePage(page, 1);
    await expect(button(secondPage(page), 'Número 5')).toBeInViewport({ ratio: 1 });
    await screenshot(page, `test-results/tv-touchpad-numbers-${info.project.name}.png`);
  });
});

test.describe('controle: aproveita a altura', () => {
  test('o controle preenche a tela: pouco vazio embaixo e o anel enche o palco', async ({
    page,
  }) => {
    await openTv(page);
    const tabs = (await page.getByRole('navigation', { name: 'Abas do módulo' }).boundingBox())!;
    const bottom = (await page.locator('.bottom').boundingBox())!;
    const gap = tabs.y - (bottom.y + bottom.height);
    expect(gap, 'vazio entre os botões de baixo e a barra de abas').toBeLessThanOrEqual(28);

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
    await expectTargetSize(button(page, 'Página 2 de 2'));
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

    test('cabe sem rolagem horizontal, com alvos de 44 px e sem esticar', async ({
      page,
    }, info) => {
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
        'Desligar a TV',
        'Trocar para o modo touchpad',
        'Atalho 1',
        'Página 1 de 2',
        'Página 2 de 2',
        'OK',
      ]) {
        await expectTargetSize(button(page, name));
      }

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

    test('a segunda página tem números de 44 px ou mais e os fixos não mexem', async ({
      page,
    }, info) => {
      await openTv(page);
      const before = await fixedBoxes(page);
      await button(page, 'Página 2 de 2').click();
      await settlePage(page, 1);
      for (const digit of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
        await expectTargetSize(button(secondPage(page), `Número ${digit}`));
      }
      await expectTargetSize(button(secondPage(page), 'Origem'));
      expect(await fixedBoxes(page)).toEqual(before);
      await expectNoHorizontalScroll(page);
      await screenshot(page, `test-results/tv-page2-${screen.name}-${info.project.name}.png`);
    });

    test('touchpad e teclado também funcionam neste tamanho', async ({ page }, info) => {
      await openTv(page);
      await button(page, 'Trocar para o modo touchpad').click();
      const pad = (await page.locator('app-touchpad-surface .pad').boundingBox())!;
      expect(pad.height).toBeGreaterThanOrEqual(120);
      await expectNoHorizontalScroll(page);
      await screenshot(page, `test-results/tv-touchpad-${screen.name}-${info.project.name}.png`);

      await page.goto('/tv/teclado');
      await expect(page.getByLabel('Texto para a TV')).toBeVisible();
      await expectNoHorizontalScroll(page);
      await screenshot(page, `test-results/tv-keyboard-${screen.name}-${info.project.name}.png`);
    });
  });
}
