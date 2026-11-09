import { join } from 'node:path';
import { Page } from '@playwright/test';
import { GUEST, IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import {
  afterFrames,
  expectNoA11yViolations,
  settle,
  smallTargets,
} from '../screens/screen-helpers';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { PcMock, READY, mockPcApi } from './pc-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints (quem roda o teste aponta uma pasta); sem a variável, ficam em `test-results`. */
const SHOTS = process.env['PC_SHOTS'] ?? 'test-results';

let identity: IdentityMock;
let pc: PcMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  pc = await mockPcApi(context, identity);
  // A Início consulta o estado da casa e abre o fluxo de eventos da TV: sem ela as telas dependeriam da API real.
  await mockTvApi(context, identity);
  await installFakeEventSource(page);
});

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Abas do módulo' });
const status = (page: Page) => page.getByRole('status').filter({ hasText: /Conectado|Sem/ });

async function openPc(page: Page, path = '/pc') {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: 'Controle do PC' })).toBeVisible();
  await expect(status(page)).toHaveText('Conectado');
  await settle(page);
}

/** Um toque curto e parado do mouse (os eventos de ponteiro são os mesmos do dedo). */
async function tap(page: Page, x: number, y: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

/** O botão esquerdo apertado pelo dedo parado: a superfície avisa na hora (sem esperar a resposta do PC). */
async function longPress(page: Page, x: number, y: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(page.locator('.pad.holding')).toBeVisible();
}

/** Liga os botões Esquerdo, Arrastar e Direito pelos ajustes (vêm desligados). */
async function turnOnClickButtons(page: Page) {
  await page.getByRole('button', { name: 'Ajustes do touchpad' }).click();
  const sheet = page.getByRole('dialog', { name: 'Ajustes' });
  await sheet.getByRole('switch', { name: 'Botões de clique' }).check();
  await sheet.getByRole('button', { name: 'Fechar', exact: true }).click();
  await expect(sheet).toHaveCount(0);
}

async function padCenter(page: Page) {
  const box = (await page.locator('.pad').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('Início', () => {
  test('o cartão do PC segue "Em Breve" sem PC ligado e abre o módulo quando há um', async ({
    page,
  }) => {
    pc.status = { available: false, online: false, apps: [] };
    await page.goto('/');
    const card = page.locator('article[data-module="pc"]');
    await expect(card).toContainText('Em Breve');
    await expect(card.locator('a')).toHaveCount(0);

    pc.status = { available: true, online: true, apps: [] };
    await page.goto('/');
    await expect(card).not.toContainText('Em Breve');
    await card.getByRole('link', { name: 'Controle do PC: Abrir controle' }).click();
    await expect(page).toHaveURL(/\/pc$/);
    await expect(status(page)).toHaveText('Conectado');
  });

  test('quem não tem a permissão não consulta o estado do PC e fica com o cartão planejado', async ({
    page,
  }) => {
    identity.role = 'guest';
    identity.guests.push({
      id: '00000000-0000-4000-8000-000000000051',
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:training'],
    });
    await page.goto('/');
    await expect(page.locator('article[data-module="pc"]')).toContainText('Em Breve');
    expect(pc.requests.filter((r) => r.path === '/status')).toHaveLength(0);
  });
});

test.describe('Mouse', () => {
  test('um dedo move o ponteiro, um toque clica e os botões (quando ligados) fazem o mesmo', async ({
    page,
  }) => {
    await openPc(page);
    await expect(page.getByRole('button', { name: 'Esquerdo' })).toHaveCount(0);
    const { x, y } = await padCenter(page);

    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 6; step++) await page.mouse.move(x + step * 12, y + step * 4);
    await page.mouse.up();
    // Os movimentos se somam em poucos pedidos (um em voo por vez): espera o total chegar, não o primeiro pedido.
    const moved = () =>
      pc
        .sent('/pointer')
        .reduce(
          (sum, body) => ({ dx: sum.dx + Number(body['dx']), dy: sum.dy + Number(body['dy']) }),
          { dx: 0, dy: 0 },
        );
    // Acelerado: anda pelo menos o que o dedo andou, e para o lado certo.
    await expect.poll(() => moved().dx).toBeGreaterThanOrEqual(72);
    expect(moved().dy).toBeGreaterThanOrEqual(24);
    expect(pc.sent('/click')).toEqual([]);

    await tap(page, x, y);
    await expect.poll(() => pc.sent('/click')).toEqual([{ button: 'LEFT' }]);

    await turnOnClickButtons(page);
    await page.getByRole('button', { name: 'Direito' }).click();
    await page.getByRole('button', { name: 'Esquerdo' }).click();
    await expect
      .poll(() => pc.sent('/click').map((body) => body['button']))
      .toEqual(['LEFT', 'RIGHT', 'LEFT']);
  });

  test('Arrastar segura o botão esquerdo até soltar', async ({ page }) => {
    await openPc(page);
    await turnOnClickButtons(page);
    const drag = page.getByRole('button', { name: 'Arrastar' });
    await drag.click();
    await expect(drag).toHaveAttribute('aria-pressed', 'true');
    await drag.click();
    await expect(drag).toHaveAttribute('aria-pressed', 'false');
    expect(pc.sent('/click')).toEqual([
      { button: 'LEFT', action: 'DOWN' },
      { button: 'LEFT', action: 'UP' },
    ]);
  });

  test('um dedo parado segura o botão esquerdo e tirar o dedo solta, sem clique', async ({
    page,
  }) => {
    await openPc(page);
    const { x, y } = await padCenter(page);
    await longPress(page, x, y);
    // O aviso é forte e inconfundível: contorno cheio e a palavra, não só uma cor.
    await expect(page.locator('.pad.holding')).toBeVisible();
    await expect(page.getByText('Arrastando', { exact: true })).toBeVisible();
    expect(pc.sent('/click')).toEqual([{ button: 'LEFT', action: 'DOWN' }]);
    await page.mouse.move(x + 60, y + 20, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator('.pad.holding')).toHaveCount(0);
    expect(pc.sent('/click')).toEqual([
      { button: 'LEFT', action: 'DOWN' },
      { button: 'LEFT', action: 'UP' },
    ]);
    await expect.poll(() => pc.sent('/pointer').length).toBeGreaterThan(0);
  });

  test('esconder a página com o botão apertado solta o botão (pagehide)', async ({ page }) => {
    await openPc(page);
    const { x, y } = await padCenter(page);
    await longPress(page, x, y);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect
      .poll(() => pc.sent('/click'))
      .toEqual([
        { button: 'LEFT', action: 'DOWN' },
        { button: 'LEFT', action: 'UP' },
      ]);
    // O dedo ainda está na tela: a superfície segue dizendo que arrasta até ele sair.
    await page.mouse.up();
    await expect(page.locator('.pad.holding')).toHaveCount(0);
  });

  test('ir para o segundo plano com o botão apertado também solta', async ({ page }) => {
    await openPc(page);
    const { x, y } = await padCenter(page);
    await longPress(page, x, y);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect
      .poll(() => pc.sent('/click').map((body) => body['action']))
      .toEqual(['DOWN', 'UP']);
    await page.mouse.up();
    await expect(page.locator('.pad.holding')).toHaveCount(0);
  });

  test('trocar de aba com o botão apertado solta o botão', async ({ page }) => {
    await openPc(page);
    await turnOnClickButtons(page);
    await page.getByRole('button', { name: 'Arrastar' }).click();
    await expect(page.getByRole('button', { name: 'Arrastar' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await tabs(page).getByRole('link', { name: 'Atalhos' }).click();
    await expect(page).toHaveURL(/\/pc\/atalhos$/);
    await expect
      .poll(() => pc.sent('/click').map((body) => body['action']))
      .toEqual(['DOWN', 'UP']);
  });

  test('se o aperto do botão falha, um soltar vai logo em seguida e nada fica apertado', async ({
    page,
  }) => {
    await openPc(page);
    // Só o aperto falha: o soltar tem de passar, e é isso que prova que nada ficou apertado.
    pc.commandFailure = { status: 504, kind: 'timeout' };
    pc.failOnly = (request) => request.body?.['action'] === 'DOWN';
    const { x, y } = await padCenter(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect
      .poll(() => pc.sent('/click').map((body) => body['action']))
      .toEqual(['DOWN', 'UP']);
    await page.mouse.up();
    await expect(page.locator('.pad.holding')).toHaveCount(0);
    // O soltar passou (só o aperto falhou): a página ao esconder não tem mais nada a soltar, então nenhum pedido novo sai.
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.waitForTimeout(300);
    expect(pc.sent('/click').map((body) => body['action'])).toEqual(['DOWN', 'UP']);
    await expect(page.getByRole('alert')).toContainText('O PC não respondeu a tempo.');
  });

  test('os ajustes mudam a sensibilidade e ficam guardados neste aparelho', async ({ page }) => {
    await openPc(page);
    await page.getByRole('button', { name: 'Ajustes do touchpad' }).click();
    const sheet = page.getByRole('dialog', { name: 'Ajustes' });
    await expect(sheet).toBeVisible();
    const pointerLevels = sheet.getByRole('group', { name: 'Sensibilidade' });
    await expect(pointerLevels.getByRole('radio', { name: 'Normal' })).toBeChecked();
    await pointerLevels.getByRole('radio', { name: 'Alta' }).check();
    await sheet.getByRole('switch', { name: 'Inverter rolagem' }).check();
    await sheet.getByRole('button', { name: 'Fechar', exact: true }).click();
    await expect(sheet).toHaveCount(0);

    const { x, y } = await padCenter(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 6; step++) await page.mouse.move(x + step * 12, y);
    await page.mouse.up();
    const total = () => pc.sent('/pointer').reduce((sum, body) => sum + Number(body['dx']), 0);
    // 72 px do dedo com ganho 1,6 (a sobra fracionária fica para o passo seguinte).
    await expect.poll(total).toBeGreaterThanOrEqual(113);
    expect(total()).toBeLessThanOrEqual(116);

    await page.reload();
    await expect(status(page)).toHaveText('Conectado');
    await page.getByRole('button', { name: 'Ajustes do touchpad' }).click();
    const again = page.getByRole('dialog', { name: 'Ajustes' });
    await expect(
      again.getByRole('group', { name: 'Sensibilidade' }).getByRole('radio', { name: 'Alta' }),
    ).toBeChecked();
    await expect(again.getByRole('switch', { name: 'Inverter rolagem' })).toBeChecked();
  });

  test('cabe na tela, sem rolagem lateral, alvos de 44 px e sem falha de acessibilidade', async ({
    page,
  }) => {
    await openPc(page);
    await expectNoHorizontalScroll(page);
    expect(await smallTargets(page)).toEqual([]);
    await expectNoA11yViolations(page);
    await expect(tabs(page).getByRole('link')).toHaveText(['Mouse', 'Atalhos', 'Mídia', 'Mais']);
  });

  test('print do Mouse', async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openPc(page);
    await screenshot(page, join(SHOTS, `pc-mouse-${info.project.name}.png`));
  });
});

/** Simula o aviso "Nova versão disponível" (que mora fora do módulo e empurra a página): uma faixa de 60 px no topo. */
async function pushPageDown(page: Page, height = 60) {
  await page.evaluate((px) => {
    const banner = document.createElement('div');
    banner.id = 'fake-update-banner';
    banner.style.height = `${px}px`;
    document.body.prepend(banner);
  }, height);
  // A medida acontece no próximo quadro depois do aviso do corpo da página.
  await afterFrames(page, 3);
}

/** Os controles da tela que ficam atrás da barra de abas ou fora da janela (não deve haver nenhum). */
async function hiddenControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const tabs = document.querySelector('app-tab-bar')!.getBoundingClientRect();
    const found: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(
      'app-pc-page button, app-pc-page a',
    )) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.bottom > tabs.top + 0.5 || box.top < 0 || box.right > window.innerWidth + 0.5) {
        const label = element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '';
        found.push(`${label} bottom=${Math.round(box.bottom)} tabs=${Math.round(tabs.top)}`);
      }
    }
    return found;
  });
}

test.describe('Tela do mouse', () => {
  test('a superfície ocupa o que sobra e nenhum controle fica atrás da barra de abas', async ({
    page,
  }) => {
    await openPc(page);
    const pad = async () => (await page.locator('.pad').boundingBox())!;
    const barBottom = async () =>
      (await page.locator('app-pc-action-bar').boundingBox())!.y +
      (await page.locator('app-pc-action-bar').boundingBox())!.height;
    const tabsTop = async () => (await page.locator('app-tab-bar').boundingBox())!.y;

    // Sem o aviso de versão: pelo menos 430 px de superfície.
    expect((await pad()).height).toBeGreaterThanOrEqual(430);
    expect(await hiddenControls(page)).toEqual([]);
    expect(await barBottom()).toBeLessThanOrEqual((await tabsTop()) + 0.5);

    // Com o aviso aberto: ainda 380 px, a barra de ações inteira à vista e a página sem rolagem a mais.
    await pushPageDown(page);
    expect((await pad()).height).toBeGreaterThanOrEqual(380);
    expect(await hiddenControls(page)).toEqual([]);
    expect(await barBottom()).toBeLessThanOrEqual((await tabsTop()) + 0.5);
    // A superfície acompanha a janela: não passa do que cabe nem encolhe à toa quando o aviso some.
    await page.evaluate(() => document.getElementById('fake-update-banner')?.remove());
    await afterFrames(page, 3);
    expect((await pad()).height).toBeGreaterThanOrEqual(430);
    expect(await hiddenControls(page)).toEqual([]);
  });

  test('o ponto de estado não cobre nenhum controle em nenhuma aba', async ({ page }) => {
    for (const route of ['/pc', '/pc/atalhos', '/pc/midia', '/pc/mais', '/pc/energia']) {
      await openPc(page, route);
      const covered = await page.evaluate(() => {
        const dot = document.querySelector('.status .dot')!.getBoundingClientRect();
        const hits: string[] = [];
        for (const element of document.querySelectorAll<HTMLElement>(
          'app-pc-page button, app-pc-page a',
        )) {
          const box = element.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;
          const overlaps =
            dot.left < box.right &&
            dot.right > box.left &&
            dot.top < box.bottom &&
            dot.bottom > box.top;
          if (overlaps)
            hits.push(element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '');
        }
        return hits;
      });
      expect(covered, route).toEqual([]);
    }
  });

  test('os sete botões da barra cabem lado a lado e têm 44 px', async ({ page }) => {
    await openPc(page);
    const buttons = page.locator('app-pc-action-bar button');
    await expect(buttons).toHaveCount(7);
    for (const box of await buttons.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().toJSON()),
    )) {
      expect(box.width).toBeGreaterThanOrEqual(43.5);
      expect(box.height).toBeGreaterThanOrEqual(43.5);
      expect(box.right).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 0.5);
    }
  });

  test('Enter, apagar, Esc e Tab saem da própria tela do mouse', async ({ page }) => {
    await openPc(page);
    await page.getByRole('button', { name: 'Enter', exact: true }).click();
    await page.getByRole('button', { name: 'Apagar', exact: true }).click();
    await page.getByRole('button', { name: 'Esc (Escape)', exact: true }).click();
    await page.getByRole('button', { name: 'Tab', exact: true }).click();
    await expect
      .poll(() => pc.sent('/key'))
      .toEqual([{ key: 'ENTER' }, { key: 'BACKSPACE' }, { key: 'ESCAPE' }, { key: 'TAB' }]);
  });

  test('segurar apagar repete, e soltar para (nunca fica apagando)', async ({ page }) => {
    await openPc(page);
    const erase = page.getByRole('button', { name: 'Apagar', exact: true });
    const box = (await erase.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(() => pc.sent('/key').length).toBeGreaterThanOrEqual(3);
    await page.mouse.up();
    // Passado o que já estava a caminho, nada mais sai.
    await page.waitForTimeout(400);
    const settled = pc.sent('/key').length;
    await page.waitForTimeout(500);
    expect(pc.sent('/key')).toHaveLength(settled);
    expect(pc.sent('/key').every((body) => body['key'] === 'BACKSPACE')).toBe(true);
  });

  test('o painel de teclas arma Ctrl, e a próxima tecla leva a combinação e solta', async ({
    page,
  }) => {
    await openPc(page);
    await page.getByRole('button', { name: 'Mais teclas', exact: true }).click();
    const panel = page.getByRole('group', { name: 'Mais teclas' }).last();
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Ctrl', exact: true }).click();
    await expect(page.locator('.armed')).toContainText('Ctrl');
    await page.getByRole('button', { name: 'Tab', exact: true }).click();
    await expect(page.locator('.armed')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Seta para a direita' }).click();
    await panel.getByRole('button', { name: 'Fn' }).click();
    await panel.getByRole('button', { name: 'F5', exact: true }).click();
    await expect
      .poll(() => pc.sent('/key'))
      .toEqual([{ key: 'TAB', modifiers: ['CTRL'] }, { key: 'RIGHT' }, { key: 'F5' }]);
    expect(await hiddenControls(page)).toEqual([]);
  });

  test('o painel aberto não deixa nenhum controle atrás da barra de abas', async ({ page }) => {
    await openPc(page);
    await page.getByRole('button', { name: 'Mais teclas', exact: true }).click();
    await page.getByRole('button', { name: 'Fn' }).click();
    await pushPageDown(page);
    expect(await hiddenControls(page)).toEqual([]);
    expect(await smallTargets(page)).toEqual([]);
  });

  test('Energia mora dentro de Mais, e a aba segue marcada nela', async ({ page }) => {
    await openPc(page, '/pc/mais');
    await expect(page.getByRole('link', { name: 'Energia' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ajustes' })).toBeVisible();
    await page.getByRole('link', { name: 'Energia' }).click();
    await expect(page).toHaveURL(/\/pc\/energia$/);
    await expect(tabs(page).getByRole('link', { name: 'Mais' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('button', { name: 'Bloquear' })).toBeVisible();
  });

  test('o endereço antigo do teclado leva à tela do mouse, com o teclado pedido', async ({
    page,
  }) => {
    await page.goto('/pc/teclado');
    await expect(status(page)).toHaveText('Conectado');
    await expect(page).toHaveURL(/\/pc\?teclado=1$/);
    await expect(page.locator('.pad')).toBeVisible();
  });

  test('com o PC desconectado a barra some junto com a tela e volta quando ele volta', async ({
    page,
  }) => {
    pc.status = { available: true, online: false, apps: [] };
    await page.goto('/pc');
    await expect(page.getByRole('heading', { name: 'PC Desconectado' })).toBeVisible();
    await expect(page.locator('app-pc-action-bar')).toHaveCount(0);
  });

  test('mantém a tela acesa enquanto está aberta e solta ao sair', async ({ page }) => {
    await page.addInitScript(() => {
      const log: string[] = [];
      (window as unknown as { wakeLog: string[] }).wakeLog = log;
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: {
          request: (type: string) => {
            log.push(`request:${type}`);
            return Promise.resolve({
              release: () => {
                log.push('release');
                return Promise.resolve();
              },
              addEventListener: () => undefined,
            });
          },
        },
      });
    });
    await openPc(page);
    const log = () => page.evaluate(() => (window as unknown as { wakeLog: string[] }).wakeLog);
    await expect.poll(log).toEqual(['request:screen']);
    await tabs(page).getByRole('link', { name: 'Mídia' }).click();
    await expect.poll(log).toEqual(['request:screen', 'release']);
  });

  test('a dica de primeiro uso some ao primeiro toque e não volta', async ({ page }) => {
    await openPc(page);
    await expect(page.locator('.hints svg')).toHaveCount(3);
    const { x, y } = await padCenter(page);
    await tap(page, x, y);
    await expect(page.locator('.hints')).toHaveCount(0);
    await page.reload();
    await expect(status(page)).toHaveText('Conectado');
    await expect(page.locator('.hints')).toHaveCount(0);
  });
});

/** Um passo de dedo sintético: `down`, `move` ou `up` do dedo `id`, na posição dada, depois de `wait` ms. */
interface FingerStep {
  readonly type: 'down' | 'move' | 'up';
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly wait?: number;
}

/**
 * Dedos de verdade são eventos de ponteiro com números diferentes; o Playwright só tem um mouse. Isto manda os mesmos
 * eventos que o navegador mandaria para dois ou três dedos no touchpad.
 */
async function fingers(page: Page, steps: readonly FingerStep[]) {
  await page.evaluate(async (list) => {
    const pad = document.querySelector('.pad')!;
    for (const step of list) {
      if (step.wait) await new Promise((resolve) => setTimeout(resolve, step.wait));
      pad.dispatchEvent(
        new PointerEvent(`pointer${step.type}`, {
          pointerId: step.id,
          pointerType: 'touch',
          isPrimary: step.id === 1,
          clientX: step.x,
          clientY: step.y,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }, steps);
}

test.describe('Gestos', () => {
  const clicks = () => pc.sent('/click');

  test('um toque clica e deixa um anel onde o dedo estava; o anel some sozinho', async ({
    page,
  }) => {
    await openPc(page);
    const { x, y } = await padCenter(page);
    await tap(page, x, y);
    await expect.poll(clicks).toEqual([{ button: 'LEFT' }]);
    await expect(page.locator('.ring[data-kind="left"]')).toBeVisible();
    await expect(page.locator('.ring')).toHaveCount(0);
  });

  test('o toque de dois dedos é o clique direito, e o de três é o do meio', async ({ page }) => {
    await openPc(page);
    const { x, y } = await padCenter(page);
    await fingers(page, [
      { type: 'down', id: 1, x: x - 30, y },
      { type: 'down', id: 2, x: x + 30, y },
      { type: 'up', id: 1, x: x - 30, y, wait: 40 },
      { type: 'up', id: 2, x: x + 30, y },
    ]);
    await expect.poll(clicks).toEqual([{ button: 'RIGHT' }]);
    await expect(page.locator('.ring[data-kind="right"]')).toBeVisible();

    await fingers(page, [
      { type: 'down', id: 1, x: x - 50, y },
      { type: 'down', id: 2, x, y },
      { type: 'down', id: 3, x: x + 50, y },
      { type: 'up', id: 1, x: x - 50, y, wait: 40 },
      { type: 'up', id: 2, x, y },
      { type: 'up', id: 3, x: x + 50, y },
    ]);
    await expect.poll(clicks).toEqual([{ button: 'RIGHT' }, { button: 'MIDDLE' }]);
    await expect(page.locator('.ring[data-kind="middle"]')).toBeVisible();
  });

  test('o clique do meio com três dedos se desliga nos ajustes', async ({ page }) => {
    await openPc(page);
    await page.getByRole('button', { name: 'Ajustes do touchpad' }).click();
    const sheet = page.getByRole('dialog', { name: 'Ajustes' });
    await sheet.getByRole('switch', { name: 'Clique do meio com três dedos' }).uncheck();
    await sheet.getByRole('button', { name: 'Fechar', exact: true }).click();
    const { x, y } = await padCenter(page);
    await fingers(page, [
      { type: 'down', id: 1, x: x - 50, y },
      { type: 'down', id: 2, x, y },
      { type: 'down', id: 3, x: x + 50, y },
      { type: 'up', id: 1, x: x - 50, y, wait: 40 },
      { type: 'up', id: 2, x, y },
      { type: 'up', id: 3, x: x + 50, y },
    ]);
    await page.waitForTimeout(200);
    expect(clicks()).toEqual([]);
  });

  test('o dedo parado aperta o botão só depois de 450 ms, e antes disso nada sai', async ({
    page,
  }) => {
    await openPc(page);
    const { x, y } = await padCenter(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(300);
    expect(clicks()).toEqual([]);
    await expect(page.locator('.pad.holding')).toBeVisible();
    await expect.poll(clicks).toEqual([{ button: 'LEFT', action: 'DOWN' }]);
    await page.mouse.up();
    await expect.poll(() => clicks().map((body) => body['action'])).toEqual(['DOWN', 'UP']);
  });

  test('arrastar com toque duplo: o toque clica, o segundo toque andando aperta, e soltar solta', async ({
    page,
  }) => {
    await openPc(page);
    await page.getByRole('button', { name: 'Ajustes do touchpad' }).click();
    const sheet = page.getByRole('dialog', { name: 'Ajustes' });
    await sheet.getByRole('switch', { name: 'Toque duplo arrasta' }).check();
    await sheet.getByRole('button', { name: 'Fechar', exact: true }).click();
    await expect(sheet).toHaveCount(0);

    const { x, y } = await padCenter(page);
    await fingers(page, [
      { type: 'down', id: 1, x, y },
      { type: 'up', id: 1, x, y, wait: 50 },
      { type: 'down', id: 1, x: x + 2, y, wait: 120 },
      { type: 'move', id: 1, x: x + 30, y, wait: 16 },
      { type: 'move', id: 1, x: x + 60, y: y + 10, wait: 16 },
      { type: 'move', id: 1, x: x + 90, y: y + 20, wait: 16 },
      { type: 'up', id: 1, x: x + 90, y: y + 20, wait: 16 },
    ]);
    await expect
      .poll(() => clicks())
      .toEqual([
        { button: 'LEFT' },
        { button: 'LEFT', action: 'DOWN' },
        { button: 'LEFT', action: 'UP' },
      ]);
    const moved = pc.sent('/pointer').reduce((sum, body) => sum + Number(body['dx']), 0);
    expect(moved).toBeGreaterThanOrEqual(80);
  });

  test('sem a opção ligada, o segundo toque andando só move o ponteiro', async ({ page }) => {
    await openPc(page);
    const { x, y } = await padCenter(page);
    await fingers(page, [
      { type: 'down', id: 1, x, y },
      { type: 'up', id: 1, x, y, wait: 50 },
      { type: 'down', id: 1, x: x + 2, y, wait: 120 },
      { type: 'move', id: 1, x: x + 40, y, wait: 16 },
      { type: 'up', id: 1, x: x + 40, y, wait: 16 },
    ]);
    await expect.poll(() => pc.sent('/pointer').length).toBeGreaterThan(0);
    expect(clicks()).toEqual([{ button: 'LEFT' }]);
  });

  test('a rolagem de dois dedos trava no eixo: só sobe e desce, mesmo com o dedo torto', async ({
    page,
  }) => {
    await openPc(page);
    const { x, y } = await padCenter(page);
    const steps: FingerStep[] = [
      { type: 'down', id: 1, x: x - 30, y },
      { type: 'down', id: 2, x: x + 30, y },
    ];
    for (let step = 1; step <= 8; step++) {
      // Principalmente vertical, com uma deriva para o lado.
      const dx = step * 3;
      const dy = step * 14;
      steps.push({ type: 'move', id: 1, x: x - 30 + dx, y: y + dy, wait: 16 });
      steps.push({ type: 'move', id: 2, x: x + 30 + dx, y: y + dy });
    }
    steps.push({ type: 'up', id: 1, x: x - 30, y: y + 112, wait: 200 });
    steps.push({ type: 'up', id: 2, x: x + 30, y: y + 112 });
    await fingers(page, steps);
    await expect.poll(() => pc.sent('/pointer').length).toBeGreaterThan(0);
    const bodies = pc.sent('/pointer');
    expect(bodies.some((body) => Number(body['scrollY']) !== 0)).toBe(true);
    expect(bodies.every((body) => body['scrollX'] === undefined)).toBe(true);
    // Rolagem não move o ponteiro.
    expect(bodies.every((body) => Number(body['dx']) === 0 && Number(body['dy']) === 0)).toBe(true);
  });

  test('um gesto rápido segue rolando depois dos dedos saírem, e um toque novo para', async ({
    page,
  }) => {
    await openPc(page);
    const { x, y } = await padCenter(page);
    const steps: FingerStep[] = [
      { type: 'down', id: 1, x: x - 30, y: y - 150 },
      { type: 'down', id: 2, x: x + 30, y: y - 150 },
    ];
    for (let step = 1; step <= 8; step++) {
      steps.push({ type: 'move', id: 1, x: x - 30, y: y - 150 + step * 32, wait: 16 });
      steps.push({ type: 'move', id: 2, x: x + 30, y: y - 150 + step * 32 });
    }
    steps.push({ type: 'up', id: 1, x: x - 30, y: y + 106, wait: 4 });
    steps.push({ type: 'up', id: 2, x: x + 30, y: y + 106 });
    await fingers(page, steps);
    const scrolled = () =>
      pc.sent('/pointer').reduce((sum, body) => sum + Math.abs(Number(body['scrollY'] ?? 0)), 0);
    await page.waitForTimeout(60);
    const atRelease = scrolled();
    // Os dedos já saíram, e a rolagem continua.
    await expect.poll(scrolled).toBeGreaterThan(atRelease);
    await page.waitForTimeout(150);
    // Um toque novo para na hora: depois dele nada mais rola.
    await fingers(page, [{ type: 'down', id: 1, x, y }]);
    await page.waitForTimeout(80);
    const afterTouch = scrolled();
    await page.waitForTimeout(300);
    expect(scrolled()).toBe(afterTouch);
    // O dedo que só parou a rolagem não começa uma pressão longa (450 ms) nem clica quando sai.
    await page.waitForTimeout(600);
    expect(clicks()).toEqual([]);
    await fingers(page, [{ type: 'up', id: 1, x, y }]);
    await page.waitForTimeout(150);
    expect(clicks()).toEqual([]);
    await expect(page.locator('.pad.holding')).toHaveCount(0);
  });

  test('um toque rápido que só para a rolagem não clica, e o toque seguinte clica normalmente', async ({
    page,
  }) => {
    await openPc(page);
    const { x, y } = await padCenter(page);
    const steps: FingerStep[] = [
      { type: 'down', id: 1, x: x - 30, y: y - 150 },
      { type: 'down', id: 2, x: x + 30, y: y - 150 },
    ];
    for (let step = 1; step <= 8; step++) {
      steps.push({ type: 'move', id: 1, x: x - 30, y: y - 150 + step * 32, wait: 16 });
      steps.push({ type: 'move', id: 2, x: x + 30, y: y - 150 + step * 32 });
    }
    steps.push({ type: 'up', id: 1, x: x - 30, y: y + 106, wait: 4 });
    steps.push({ type: 'up', id: 2, x: x + 30, y: y + 106 });
    await fingers(page, steps);
    await page.waitForTimeout(60);
    await fingers(page, [
      { type: 'down', id: 1, x, y },
      { type: 'up', id: 1, x, y, wait: 50 },
    ]);
    await page.waitForTimeout(200);
    expect(clicks()).toEqual([]);
    await tap(page, x, y);
    await expect.poll(clicks).toEqual([{ button: 'LEFT' }]);
  });

  test('a rolagem que segue sozinha para quando a página vai para o segundo plano', async ({
    page,
  }) => {
    await openPc(page);
    const { x, y } = await padCenter(page);
    const steps: FingerStep[] = [
      { type: 'down', id: 1, x: x - 30, y: y - 150 },
      { type: 'down', id: 2, x: x + 30, y: y - 150 },
    ];
    for (let step = 1; step <= 8; step++) {
      steps.push({ type: 'move', id: 1, x: x - 30, y: y - 150 + step * 32, wait: 16 });
      steps.push({ type: 'move', id: 2, x: x + 30, y: y - 150 + step * 32 });
    }
    steps.push({ type: 'up', id: 1, x: x - 30, y: y + 106, wait: 4 });
    steps.push({ type: 'up', id: 2, x: x + 30, y: y + 106 });
    await fingers(page, steps);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.waitForTimeout(100);
    const scrolled = () => pc.sent('/pointer').length;
    const after = scrolled();
    await page.waitForTimeout(400);
    expect(scrolled()).toBe(after);
  });

  test('com "reduzir movimento" a rolagem não segue sozinha', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openPc(page);
    const { x, y } = await padCenter(page);
    const steps: FingerStep[] = [
      { type: 'down', id: 1, x: x - 30, y: y - 150 },
      { type: 'down', id: 2, x: x + 30, y: y - 150 },
    ];
    for (let step = 1; step <= 8; step++) {
      steps.push({ type: 'move', id: 1, x: x - 30, y: y - 150 + step * 32, wait: 16 });
      steps.push({ type: 'move', id: 2, x: x + 30, y: y - 150 + step * 32 });
    }
    steps.push({ type: 'up', id: 1, x: x - 30, y: y + 106, wait: 4 });
    steps.push({ type: 'up', id: 2, x: x + 30, y: y + 106 });
    await fingers(page, steps);
    await page.waitForTimeout(150);
    const settled = pc.sent('/pointer').length;
    await page.waitForTimeout(400);
    expect(pc.sent('/pointer').length).toBe(settled);
  });

  test('os ajustes novos ficam guardados neste aparelho', async ({ page }) => {
    await openPc(page);
    await page.getByRole('button', { name: 'Ajustes do touchpad' }).click();
    const sheet = page.getByRole('dialog', { name: 'Ajustes' });
    await sheet
      .getByRole('group', { name: 'Rolagem' })
      .getByRole('radio', { name: 'Alta' })
      .check();
    await sheet.getByRole('switch', { name: 'Toque duplo arrasta' }).check();
    await sheet.getByRole('button', { name: 'Fechar', exact: true }).click();
    await page.reload();
    await expect(status(page)).toHaveText('Conectado');
    await page.getByRole('button', { name: 'Ajustes do touchpad' }).click();
    const again = page.getByRole('dialog', { name: 'Ajustes' });
    await expect(
      again.getByRole('group', { name: 'Rolagem' }).getByRole('radio', { name: 'Alta' }),
    ).toBeChecked();
    await expect(again.getByRole('switch', { name: 'Toque duplo arrasta' })).toBeChecked();
    await expect(
      again.getByRole('switch', { name: 'Clique do meio com três dedos' }),
    ).toBeChecked();
  });
});

test.describe('Digitação ao vivo', () => {
  /** Abre o teclado do celular (o foco nasce no toque do botão) e devolve o campo escondido. */
  async function openKeyboard(page: Page) {
    await page.getByRole('button', { name: 'Teclado', exact: true }).click();
    const field = page.getByLabel('Digitar no PC');
    await expect(field).toBeFocused();
    return field;
  }
  const typed = () =>
    pc
      .sent('/text')
      .map((body) => String(body['text']))
      .join('');

  test('cada letra vai ao PC na hora, sem botão de enviar, e o campo não mostra nada', async ({
    page,
  }) => {
    await openPc(page);
    await openKeyboard(page);
    await expect(page.getByRole('button', { name: 'Teclado', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.keyboard.type('olá, mundo');
    await expect.poll(typed).toBe('olá, mundo');
    await expect(page.getByRole('button', { name: 'Digitar', exact: true })).toHaveCount(0);
  });

  test('com a rede lenta o que se digita se junta: poucos pedidos, o texto inteiro e na ordem', async ({
    page,
  }) => {
    pc.commandDelayMs = 300;
    await openPc(page);
    await openKeyboard(page);
    await page.keyboard.type('abcdefghij', { delay: 20 });
    await expect.poll(typed).toBe('abcdefghij');
    // Uma letra por pedido seriam dez; o que chegou enquanto um voava saiu junto.
    expect(pc.sent('/text').length).toBeLessThanOrEqual(4);
    expect(pc.sent('/key')).toEqual([]);
  });

  test('apagar manda Backspace, mesmo com o campo vazio', async ({ page }) => {
    await openPc(page);
    const field = await openKeyboard(page);
    await field.press('Backspace');
    await expect.poll(() => pc.sent('/key')).toEqual([{ key: 'BACKSPACE' }]);
    await field.pressSequentially('ab');
    await expect.poll(typed).toBe('ab');
    await field.press('Backspace');
    await expect.poll(() => pc.sent('/key')).toEqual([{ key: 'BACKSPACE' }, { key: 'BACKSPACE' }]);
  });

  test('Enter e Tab saem como tecla, nunca como texto, e o foco fica no campo', async ({
    page,
  }) => {
    await openPc(page);
    const field = await openKeyboard(page);
    await field.pressSequentially('oi');
    await field.press('Enter');
    await field.press('Tab');
    await expect.poll(() => pc.sent('/key')).toEqual([{ key: 'ENTER' }, { key: 'TAB' }]);
    expect(typed()).toBe('oi');
    await expect(field).toBeFocused();
  });

  test('o Enter da barra de ações nunca passa na frente do texto digitado antes dele', async ({
    page,
  }) => {
    pc.commandDelayMs = 250;
    await openPc(page);
    const field = await openKeyboard(page);
    await field.pressSequentially('oi');
    await page.getByRole('button', { name: 'Enter', exact: true }).click();
    await expect.poll(() => pc.sent('/key')).toEqual([{ key: 'ENTER' }]);
    expect(typed()).toBe('oi');
  });

  test('apagar na barra tira também a letra do campo, e o texto seguinte sai certo', async ({
    page,
  }) => {
    await openPc(page);
    const field = await openKeyboard(page);
    await field.pressSequentially('ab');
    await expect.poll(typed).toBe('ab');
    await page.getByRole('button', { name: 'Apagar', exact: true }).click();
    await expect.poll(() => pc.sent('/key')).toEqual([{ key: 'BACKSPACE' }]);
    await field.pressSequentially('c');
    await expect.poll(typed).toBe('abc');
  });

  test('o preenchimento invisível do campo nunca vai ao PC, nem se o campo perder e ganhar o foco', async ({
    page,
  }) => {
    await openPc(page);
    const field = await openKeyboard(page);
    await field.pressSequentially('ab');
    await expect.poll(typed).toBe('ab');
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    // O foco volta com o texto do campo todo selecionado (como no Tab): digitar por cima não apaga nada do PC.
    await field.pressSequentially('c');
    await expect.poll(typed).toBe('abc');
    expect(typed()).not.toContain('​');
    expect(pc.sent('/key')).toEqual([]);
  });

  test('uma tecla armada com uma letra digitada vira o atalho, e a letra não vira texto', async ({
    page,
  }) => {
    await openPc(page);
    await openKeyboard(page);
    await page
      .getByRole('group', { name: 'Teclas armadas' })
      .getByRole('button', { name: 'Win' })
      .click();
    await page.keyboard.type('d');
    await expect.poll(() => pc.sent('/key')).toEqual([{ key: 'D', modifiers: ['WIN'] }]);
    expect(pc.sent('/text')).toEqual([]);
    await expect(page.locator('.armed')).toHaveCount(0);
  });

  test('um texto colado com várias linhas sai linha a linha, com Enter entre elas', async ({
    page,
  }) => {
    await openPc(page);
    const field = await openKeyboard(page);
    await page.keyboard.insertText('um\ndois\ntrês');
    await expect.poll(typed).toBe('umdoistrês');
    await expect.poll(() => pc.sent('/key')).toEqual([{ key: 'ENTER' }, { key: 'ENTER' }]);
    await expect(field).toBeFocused();
  });

  test('tocar uma tecla da barra com o teclado aberto o mantém aberto, e o botão do teclado o fecha', async ({
    page,
  }) => {
    await openPc(page);
    const field = await openKeyboard(page);
    await page.getByRole('button', { name: 'Tab', exact: true }).click();
    await expect(field).toBeFocused();
    const toggle = page.getByRole('button', { name: 'Teclado', exact: true });
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(field).not.toBeFocused();
    // Fechado de propósito, uma tecla da barra não o reabre.
    await page.getByRole('button', { name: 'Tab', exact: true }).click();
    await expect(field).not.toBeFocused();
  });

  test('o sistema fechar o teclado (o foco sai do campo sem toque na tela) desliga o botão', async ({
    page,
  }) => {
    await openPc(page);
    const field = await openKeyboard(page);
    // Acabado o toque no botão do teclado, perder o foco é o sistema.
    await field.evaluate((element) => (element as HTMLElement).blur());
    await expect(page.getByRole('button', { name: 'Teclado', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('uma tecla que falha com texto esperando atrás avisa que o texto não foi enviado e recomeça o campo', async ({
    page,
  }) => {
    pc.commandDelayMs = 150;
    await openPc(page);
    const field = await openKeyboard(page);
    pc.commandFailure = { status: 504, kind: 'timeout' };
    pc.failOnly = (request) => request.path === '/key';
    await page.getByRole('button', { name: 'Enter', exact: true }).click();
    await field.pressSequentially('oi');
    await expect(page.locator('.toast')).toContainText('O texto não foi enviado.');
    expect(typed()).toBe('');
    pc.commandFailure = null;
    await field.pressSequentially('z');
    await expect.poll(typed).toBe('z');
  });

  test('o emoji vai inteiro', async ({ page }) => {
    await openPc(page);
    const field = await openKeyboard(page);
    await field.pressSequentially('oi ');
    await page.keyboard.insertText('😀');
    await expect.poll(typed).toBe('oi 😀');
  });

  test('uma falha incerta avisa que parte do texto pode não ter chegado e recomeça o campo', async ({
    page,
  }) => {
    await openPc(page);
    const field = await openKeyboard(page);
    pc.commandFailure = { status: 504, kind: 'timeout' };
    await field.pressSequentially('a');
    await expect(page.locator('.toast')).toContainText('Parte do texto pode não ter chegado.');
    // O motivo vem do aviso de falha da tela, sem repetir.
    await expect(page.locator('.notice')).toContainText('O PC não respondeu a tempo.');
    pc.commandFailure = null;
    await field.pressSequentially('z');
    await expect.poll(typed).toBe('az');
  });

  test('o painel de teclas continua à mão com o teclado aberto, e nada fica atrás da barra de abas', async ({
    page,
  }) => {
    await openPc(page);
    await openKeyboard(page);
    await page.getByRole('button', { name: 'Mais teclas', exact: true }).click();
    expect(await hiddenControls(page)).toEqual([]);
    expect(await smallTargets(page)).toEqual([]);
    await expectNoA11yViolations(page);
  });
});

test.describe('Atalhos', () => {
  const keyRequests = () => pc.sent('/key');
  const openSheet = async (page: Page) => {
    await page.getByRole('button', { name: 'Atalhos', exact: true }).first().click();
    const sheet = page.getByRole('dialog', { name: 'Atalhos' });
    await expect(sheet).toBeVisible();
    return sheet;
  };

  test('a aba mostra o catálogo agrupado, e tocar envia o atalho como tecla e modificadores', async ({
    page,
  }) => {
    await openPc(page, '/pc/atalhos');
    for (const title of [
      'Fixados',
      'Edição',
      'Janela',
      'Sistema',
      'Navegador',
      'Vídeo',
      'Apresentação',
    ]) {
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    }
    await page.locator('[data-shortcut="copy"]').first().click();
    await page.locator('[data-shortcut="switch-window"]').first().click();
    await page.locator('[data-shortcut="task-manager"]').click();
    await page.locator('[data-shortcut="reopen-tab"]').click();
    await page.locator('[data-shortcut="slides-end"]').click();
    await expect
      .poll(keyRequests)
      .toEqual([
        { key: 'C', modifiers: ['CTRL'] },
        { key: 'TAB', modifiers: ['ALT'] },
        { key: 'ESCAPE', modifiers: ['CTRL', 'SHIFT'] },
        { key: 'T', modifiers: ['CTRL', 'SHIFT'] },
        { key: 'ESCAPE' },
      ]);
  });

  test('bloquear é a ação de energia do PC, na hora, sem Win+L', async ({ page }) => {
    await openPc(page, '/pc/atalhos');
    await page.locator('[data-shortcut="lock"]').click();
    await expect.poll(() => pc.sent('/power')).toEqual([{ action: 'LOCK' }]);
    expect(keyRequests()).toEqual([]);
  });

  test('o texto de cada atalho diz o que faz, e a tecla vem pequena embaixo', async ({ page }) => {
    await openPc(page, '/pc/atalhos');
    const copy = page.locator('[data-shortcut="copy"]').first();
    await expect(copy.locator('.name')).toHaveText('Copiar');
    await expect(copy.locator('.keys')).toHaveText('Ctrl+C');
  });

  test('as teclas armadas no painel valem para a tecla seguinte e se soltam', async ({ page }) => {
    await openPc(page);
    await page.getByRole('button', { name: 'Mais teclas', exact: true }).click();
    const panel = page.getByRole('group', { name: 'Mais teclas' }).last();
    await panel.getByRole('button', { name: 'Ctrl', exact: true }).click();
    await panel.getByRole('button', { name: 'Alt', exact: true }).click();
    await panel.getByRole('button', { name: 'Del (Delete)' }).click();
    await expect.poll(keyRequests).toEqual([{ key: 'DELETE', modifiers: ['CTRL', 'ALT'] }]);
    await expect(page.locator('.armed')).toHaveCount(0);
  });

  test('as teclas armadas aparecem na aba Atalhos e na folha, e sair do módulo as solta', async ({
    page,
  }) => {
    await openPc(page);
    await page.getByRole('button', { name: 'Mais teclas', exact: true }).click();
    await page
      .getByRole('group', { name: 'Mais teclas' })
      .last()
      .getByRole('button', { name: 'Win', exact: true })
      .click();
    // Na folha do raio.
    const sheet = await openSheet(page);
    await expect(sheet.getByRole('button', { name: 'Soltar Win' })).toBeVisible();
    await sheet.locator('[data-shortcut="find"]').first().click();
    await expect.poll(keyRequests).toEqual([{ key: 'F', modifiers: ['CTRL', 'WIN'] }]);
    await expect(sheet.locator('app-pc-armed-pills .pill')).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Fechar', exact: true }).click();

    // Na aba Atalhos, e a pílula solta a tecla (o painel de teclas segue aberto na tela do mouse).
    await page
      .getByRole('group', { name: 'Mais teclas' })
      .last()
      .getByRole('button', { name: 'Win', exact: true })
      .click();
    await tabs(page).getByRole('link', { name: 'Atalhos' }).click();
    const pill = page.locator('app-pc-armed-pills .pill');
    await expect(pill).toHaveText('Win');
    await pill.click();
    await expect(pill).toHaveCount(0);

    // Sair do módulo solta o que ficou armado.
    await tabs(page).getByRole('link', { name: 'Mouse' }).click();
    await page.getByRole('button', { name: 'Mais teclas', exact: true }).click();
    await page
      .getByRole('group', { name: 'Mais teclas' })
      .last()
      .getByRole('button', { name: 'Alt', exact: true })
      .click();
    await expect(page.locator('.armed')).toContainText('Alt');
    await page.getByRole('button', { name: 'Voltar ao Início' }).click();
    await page
      .locator('article[data-module="pc"]')
      .getByRole('link', { name: 'Controle do PC: Abrir controle' })
      .click();
    await expect(status(page)).toHaveText('Conectado');
    await expect(page.locator('.armed')).toHaveCount(0);
  });

  test('a folha do raio abre sobre o mouse, fica aberta depois de cada toque e fecha pelo X', async ({
    page,
  }) => {
    await openPc(page);
    const sheet = await openSheet(page);
    await sheet.locator('[data-shortcut="switch-window"]').first().click();
    await sheet.locator('[data-shortcut="switch-window"]').first().click();
    await sheet.locator('[data-shortcut="show-desktop"]').first().click();
    await expect.poll(keyRequests).toEqual([
      { key: 'TAB', modifiers: ['ALT'] },
      { key: 'TAB', modifiers: ['ALT'] },
      { key: 'D', modifiers: ['WIN'] },
    ]);
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Fechar', exact: true }).click();
    await expect(sheet).toHaveCount(0);
  });

  test('a folha fecha pelo Esc e o botão do raio volta ao normal', async ({ page }) => {
    await openPc(page);
    const open = page.getByRole('button', { name: 'Atalhos', exact: true }).first();
    const sheet = await openSheet(page);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(open).toHaveAttribute('aria-expanded', 'false');
  });

  test('Arrastar vive na folha: trava o botão esquerdo até soltar, e fechar a folha não o solta', async ({
    page,
  }) => {
    await openPc(page);
    const sheet = await openSheet(page);
    const drag = sheet.getByRole('button', { name: 'Arrastar' });
    await drag.click();
    await expect(drag).toHaveAttribute('aria-pressed', 'true');
    await sheet.getByRole('button', { name: 'Fechar', exact: true }).click();
    await expect(page.locator('.pad.holding')).toBeVisible();
    const again = await openSheet(page);
    await again.getByRole('button', { name: 'Arrastar' }).click();
    await expect
      .poll(() => pc.sent('/click').map((body) => body['action']))
      .toEqual(['DOWN', 'UP']);
  });

  test('esconder a página com o botão travado pela folha solta o botão', async ({ page }) => {
    await openPc(page);
    const sheet = await openSheet(page);
    await sheet.getByRole('button', { name: 'Arrastar' }).click();
    await expect(sheet.getByRole('button', { name: 'Arrastar' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect
      .poll(() => pc.sent('/click').map((body) => body['action']))
      .toEqual(['DOWN', 'UP']);
  });

  test('os fixados se editam com o lápis e voltam depois de recarregar', async ({ page }) => {
    await openPc(page, '/pc/atalhos');
    const pinnedGroup = () => page.locator('section.group').first();
    await expect(pinnedGroup().locator('[data-shortcut="save"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Editar fixados' }).click();
    // Editando, tocar fixa e nada é enviado.
    await page.locator('[data-shortcut="save"]').last().click();
    await expect(pinnedGroup().locator('[data-shortcut="save"]')).toHaveCount(1);
    await pinnedGroup().locator('[data-shortcut="copy"]').click();
    await expect(pinnedGroup().locator('[data-shortcut="copy"]')).toHaveCount(0);
    expect(keyRequests()).toEqual([]);

    await page.reload();
    await expect(status(page)).toHaveText('Conectado');
    await expect(pinnedGroup().locator('[data-shortcut="save"]')).toHaveCount(1);
    await expect(pinnedGroup().locator('[data-shortcut="copy"]')).toHaveCount(0);
    // Fora da edição, o fixado envia.
    await pinnedGroup().locator('[data-shortcut="save"]').click();
    await expect.poll(keyRequests).toEqual([{ key: 'S', modifiers: ['CTRL'] }]);
  });

  test('os fixados ficam guardados por conta neste aparelho', async ({ page }) => {
    await openPc(page, '/pc/atalhos');
    await page.getByRole('button', { name: 'Editar fixados' }).click();
    await page.locator('[data-shortcut="save"]').last().click();
    const names = await page.evaluate(() =>
      Object.keys(localStorage).filter((name) => name.startsWith('uniover.pc.pinned.v1.')),
    );
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe('uniover.pc.pinned.v1');
  });

  test('sem PC a aba não mostra atalhos mortos', async ({ page }) => {
    pc.status = { available: true, online: false, apps: [] };
    await page.goto('/pc/atalhos');
    await expect(page.getByRole('heading', { name: 'PC Desconectado' })).toBeVisible();
    await expect(page.locator('[data-shortcut]')).toHaveCount(0);
  });

  test('a aba cabe na tela, tem alvos de 44 px e nenhuma falha de acessibilidade', async ({
    page,
  }) => {
    await openPc(page, '/pc/atalhos');
    await expectNoHorizontalScroll(page);
    expect(await smallTargets(page)).toEqual([]);
    await expectNoA11yViolations(page);
  });

  test('a folha aberta tem alvos de 44 px, cabe na janela e não tem falha de acessibilidade', async ({
    page,
  }) => {
    await openPc(page);
    const sheet = await openSheet(page);
    await settle(page);
    const box = (await sheet.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 0.5);
    expect(box.width).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(await smallTargets(page)).toEqual([]);
    await expectNoA11yViolations(page);
  });
});

test.describe('Mídia', () => {
  test('toca, pausa, muda a faixa, ajusta o volume e abre um favorito do PC', async ({ page }) => {
    await openPc(page, '/pc/midia');
    await page.getByRole('button', { name: 'Tocar ou pausar' }).click();
    await page.getByRole('button', { name: 'Próxima faixa' }).click();
    await page.getByRole('button', { name: 'Aumentar o volume' }).click();
    await page.getByRole('button', { name: 'Mudo' }).click();
    await expect
      .poll(() => pc.sent('/media').map((body) => body['action']))
      .toEqual(['PLAY_PAUSE', 'NEXT', 'VOLUME_UP', 'MUTE']);

    await expect(page.locator('.app')).toHaveText(['Navegador', 'Notas']);
    await page.getByRole('button', { name: 'Notas' }).click();
    await expect.poll(() => pc.sent('/apps/notas/launch').length).toBe(1);
  });

  test('sem favoritos a seção nem aparece', async ({ page }) => {
    pc.status = { ...pc.status, apps: [] };
    await openPc(page, '/pc/midia');
    await expect(page.getByRole('heading', { name: 'Abrir no PC' })).toHaveCount(0);
  });

  test('cabe na tela e não tem falha de acessibilidade', async ({ page }) => {
    await openPc(page, '/pc/midia');
    await expectNoHorizontalScroll(page);
    expect(await smallTargets(page)).toEqual([]);
    await expectNoA11yViolations(page);
  });

  test('print da Mídia', async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openPc(page, '/pc/midia');
    await screenshot(page, join(SHOTS, `pc-midia-${info.project.name}.png`));
  });
});

test.describe('Energia', () => {
  test('bloquear vale na hora, sem pergunta', async ({ page }) => {
    await openPc(page, '/pc/energia');
    await page.getByRole('button', { name: 'Bloquear' }).click();
    await expect.poll(() => pc.sent('/power')).toEqual([{ action: 'LOCK' }]);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('desligar pede confirmação, só envia depois dela e oferece cancelar a contagem', async ({
    page,
  }) => {
    await openPc(page, '/pc/energia');
    await page.getByRole('button', { name: 'Desligar', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Desligar o PC?' });
    await expect(sheet).toBeVisible();
    expect(pc.sent('/power')).toEqual([]);

    await sheet.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    expect(pc.sent('/power')).toEqual([]);

    await page.getByRole('button', { name: 'Desligar', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Desligar o PC?' })
      .getByRole('button', { name: 'Desligar', exact: true })
      .click();
    await expect.poll(() => pc.sent('/power')).toEqual([{ action: 'SHUTDOWN', confirm: true }]);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('button', { name: 'Cancelar Desligamento' }).click();
    await expect
      .poll(() => pc.sent('/power').map((body) => body['action']))
      .toEqual(['SHUTDOWN', 'CANCEL_SHUTDOWN']);
    await expect(page.getByRole('button', { name: 'Cancelar Desligamento' })).toHaveCount(0);
  });

  test('suspender também pede confirmação', async ({ page }) => {
    await openPc(page, '/pc/energia');
    await page.getByRole('button', { name: 'Suspender', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Suspender o PC?' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Suspender', exact: true }).click();
    await expect.poll(() => pc.sent('/power')).toEqual([{ action: 'SLEEP', confirm: true }]);
  });

  test('a falha do PC aparece dentro da folha, que continua aberta', async ({ page }) => {
    await openPc(page, '/pc/energia');
    pc.commandFailure = { status: 502, kind: 'command-failed', extra: { agentError: 'failed' } };
    await page.getByRole('button', { name: 'Desligar', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Desligar o PC?' });
    await sheet.getByRole('button', { name: 'Desligar', exact: true }).click();
    await expect(sheet.getByRole('alert')).toHaveText('O PC não executou o comando.');
    await expect(sheet).toBeVisible();
  });

  test('cabe na tela, a folha tem alvos de 44 px e não tem falha de acessibilidade', async ({
    page,
  }) => {
    await openPc(page, '/pc/energia');
    await expectNoHorizontalScroll(page);
    expect(await smallTargets(page)).toEqual([]);
    await expectNoA11yViolations(page);
    await page.getByRole('button', { name: 'Desligar', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Desligar o PC?' })).toBeVisible();
    await settle(page);
    expect(await smallTargets(page)).toEqual([]);
    await expectNoA11yViolations(page);
  });
});

test.describe('Estados', () => {
  test('PC desconectado: avisa, não mostra controle morto e tenta de novo', async ({ page }) => {
    pc.status = { available: true, online: false, apps: [] };
    await page.goto('/pc');
    await expect(page.getByRole('heading', { name: 'PC Desconectado' })).toBeVisible();
    await expect(page.locator('.pad')).toHaveCount(0);

    pc.status = { ...pc.status, online: true };
    await page.getByRole('button', { name: 'Tentar de Novo' }).click();
    await expect(status(page)).toHaveText('Conectado');
    await expect(page.locator('.pad')).toBeVisible();
  });

  test('sem PC seu com o controle ligado: diz como instalar e ligar', async ({ page }) => {
    pc.status = { available: false, online: false, apps: [] };
    await page.goto('/pc');
    await expect(page.getByRole('heading', { name: 'Nenhum PC Seu Conectado' })).toBeVisible();
    await expect(page.getByText('uniover-agent pc-control on')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Instalar o Conector' })).toHaveAttribute(
      'href',
      '/conectar',
    );
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
  });

  test('o PC que cai no meio do uso muda a tela', async ({ page }) => {
    await openPc(page, '/pc/midia');
    pc.status = { ...pc.status, online: false };
    pc.commandFailure = { status: 503, kind: 'agent-offline' };
    await page.getByRole('button', { name: 'Mudo' }).click();
    await expect(page.getByRole('heading', { name: 'PC Desconectado' })).toBeVisible();
  });

  test('conta sem a permissão volta à Início e nunca chama a API do PC', async ({ page }) => {
    identity.role = 'guest';
    identity.guests.push({
      id: '00000000-0000-4000-8000-000000000051',
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:training'],
    });
    await page.goto('/pc');
    await expect(page).not.toHaveURL(/\/pc/);
    expect(pc.denied).toEqual([]);
  });

  test('convidada com a permissão do PC usa o módulo', async ({ page }) => {
    identity.role = 'guest';
    identity.guests.push({
      id: '00000000-0000-4000-8000-000000000051',
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:pc'],
    });
    await openPc(page);
    const { x, y } = await padCenter(page);
    await tap(page, x, y);
    await expect.poll(() => pc.sent('/click')).toEqual([{ button: 'LEFT' }]);
    expect(pc.denied).toEqual([]);
  });
});

test.describe('Teclas do pc.key.v2', () => {
  /** O agente declarou `pc.key.v2`: a tela repete em lotes, segura o Alt e mostra as teclas novas. */
  test.beforeEach(() => {
    pc.status = { ...READY, apps: [...READY.apps], capabilities: ['pc.key.v2'] };
  });

  const keyBodies = () => pc.sent('/key');
  const releases = () => pc.sent('/key/release');
  const bar = (page: Page) => page.getByRole('group', { name: 'Trocando de janela' });

  async function openSheet(page: Page) {
    await page.getByRole('button', { name: 'Atalhos', exact: true }).first().click();
    const sheet = page.getByRole('dialog', { name: 'Atalhos' });
    await expect(sheet).toBeVisible();
    return sheet;
  }

  /** Trocar janela pela folha de atalhos: o Alt fica segurado e a folha fecha, dando lugar à barra. */
  async function holdAlt(page: Page) {
    const sheet = await openSheet(page);
    await sheet.locator('[data-shortcut="switch-window"]').first().click();
    await expect(bar(page)).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Atalhos' })).toHaveCount(0);
  }

  async function holdDown(page: Page, locator: ReturnType<Page['locator']>) {
    const box = (await locator.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  }

  test.describe('apagar segurado', () => {
    test('manda lotes com repeat: o primeiro toque é uma tecla só, e soltar para tudo', async ({
      page,
    }) => {
      await openPc(page);
      await holdDown(page, page.getByRole('button', { name: 'Apagar', exact: true }));
      await expect.poll(() => keyBodies().length).toBeGreaterThanOrEqual(3);
      await page.mouse.up();
      await page.waitForTimeout(400);
      const settled = keyBodies().length;
      await page.waitForTimeout(500);
      expect(keyBodies()).toHaveLength(settled);
      const [first, ...batches] = keyBodies();
      expect(first).toEqual({ key: 'BACKSPACE' });
      expect(batches.length).toBeGreaterThanOrEqual(2);
      for (const body of batches) {
        expect(body['key']).toBe('BACKSPACE');
        expect(Number(body['repeat'])).toBeGreaterThanOrEqual(2);
        expect(Number(body['repeat'])).toBeLessThanOrEqual(8);
      }
      // Menos pedidos do que apagadas: é o ponto dos lotes.
      const erased = keyBodies().reduce((sum, body) => sum + Number(body['repeat'] ?? 1), 0);
      expect(erased).toBeGreaterThan(keyBodies().length);
    });

    test('uma seta segurada no painel também repete em lotes', async ({ page }) => {
      await openPc(page);
      await page.getByRole('button', { name: 'Mais teclas', exact: true }).click();
      const panel = page.getByRole('group', { name: 'Mais teclas' }).last();
      await holdDown(page, panel.getByRole('button', { name: 'Seta para a direita' }));
      await expect.poll(() => keyBodies().length).toBeGreaterThanOrEqual(3);
      await page.mouse.up();
      expect(keyBodies().every((body) => body['key'] === 'RIGHT')).toBe(true);
      expect(
        keyBodies()
          .slice(1)
          .every((body) => Number(body['repeat']) >= 2),
      ).toBe(true);
    });

    test('um agente antigo segue com uma tecla por pedido, sem nenhum repeat', async ({ page }) => {
      pc.status = { ...READY, apps: [...READY.apps] };
      await openPc(page);
      await holdDown(page, page.getByRole('button', { name: 'Apagar', exact: true }));
      await expect.poll(() => keyBodies().length).toBeGreaterThanOrEqual(3);
      await page.mouse.up();
      expect(keyBodies().every((body) => body['key'] === 'BACKSPACE' && !('repeat' in body))).toBe(
        true,
      );
    });
  });

  test.describe('as teclas novas do painel', () => {
    test('um agente antigo não vê o botão dos dígitos', async ({ page }) => {
      pc.status = { ...READY, apps: [...READY.apps] };
      await openPc(page);
      await page.getByRole('button', { name: 'Mais teclas', exact: true }).click();
      await expect(page.getByRole('group', { name: 'Mais teclas' }).last()).toBeVisible();
      await expect(page.locator('[data-more-toggle]')).toHaveCount(0);
    });

    test('com pc.key.v2 o painel mostra os dígitos, a pontuação e as especiais, e cada uma sai com o seu código', async ({
      page,
    }) => {
      await openPc(page);
      await page.getByRole('button', { name: 'Mais teclas', exact: true }).click();
      await page.locator('[data-more-toggle]').click();
      await expect(
        page.getByRole('group', { name: 'Dígitos e outras teclas' }).last(),
      ).toBeVisible();
      const codes = [
        'D1',
        'D0',
        'MINUS',
        'EQUALS',
        'COMMA',
        'PERIOD',
        'INSERT',
        'PRINT_SCREEN',
        'WIN',
        'CAPS_LOCK',
        'APPS',
      ];
      for (const code of codes) await page.locator(`[data-key="${code}"]`).click();
      await expect.poll(keyBodies).toEqual(codes.map((key) => ({ key })));
      // Nenhum controle atrás da barra de abas, e todos com 44 px.
      expect(await hiddenControls(page)).toEqual([]);
      expect(await smallTargets(page)).toEqual([]);
    });
  });

  test.describe('Trocar janela com o Alt segurado', () => {
    test('segura o Alt, cada toque é um Tab (Shift+Tab volta) e Soltar solta', async ({ page }) => {
      await openPc(page);
      await holdAlt(page);
      await expect.poll(keyBodies).toEqual([{ key: 'ALT', action: 'DOWN' }, { key: 'TAB' }]);
      await expect(bar(page).locator('.held')).toHaveText('Alt');
      await bar(page)
        .getByRole('button', { name: /Próxima/ })
        .click();
      await bar(page)
        .getByRole('button', { name: /Anterior/ })
        .click();
      await expect
        .poll(keyBodies)
        .toEqual([
          { key: 'ALT', action: 'DOWN' },
          { key: 'TAB' },
          { key: 'TAB' },
          { key: 'TAB', modifiers: ['SHIFT'] },
        ]);
      // Nada solta o Alt até a pessoa mandar.
      expect(releases()).toEqual([]);
      await bar(page).getByRole('button', { name: 'Soltar' }).click();
      await expect.poll(releases).toEqual([{ key: 'ALT' }]);
      await expect(bar(page)).toHaveCount(0);
    });

    test('Soltar logo depois de Próxima só solta depois do último Tab', async ({ page }) => {
      await openPc(page);
      await holdAlt(page);
      pc.commandDelayMs = 250;
      await bar(page)
        .getByRole('button', { name: /Próxima/ })
        .click();
      await bar(page).getByRole('button', { name: 'Soltar' }).click();
      await expect.poll(releases).toEqual([{ key: 'ALT' }]);
      expect(keyBodies().filter((body) => body['key'] === 'TAB')).toHaveLength(2);
      const order = pc.requests.filter((r) => r.path === '/key' || r.path === '/key/release');
      expect(order.at(-1)?.path).toBe('/key/release');
    });

    test('o painel de teclas tem o botão "Alt+Tab", e a barra que aparece solta', async ({
      page,
    }) => {
      await openPc(page);
      await page.getByRole('button', { name: 'Mais teclas', exact: true }).click();
      await page.locator('[data-more-toggle]').click();
      await page.locator('[data-switch-window]').click();
      await expect(bar(page)).toBeVisible();
      // O painel dá o lugar à barra.
      await expect(page.locator('app-pc-key-panel')).toHaveCount(0);
      await expect.poll(keyBodies).toEqual([{ key: 'ALT', action: 'DOWN' }, { key: 'TAB' }]);
      await bar(page).getByRole('button', { name: 'Soltar' }).click();
      await expect.poll(releases).toEqual([{ key: 'ALT' }]);
    });

    test('a barra acompanha a pessoa pelas abas do módulo, e Soltar funciona em qualquer uma', async ({
      page,
    }) => {
      await openPc(page);
      await holdAlt(page);
      await tabs(page).getByRole('link', { name: 'Mídia' }).click();
      await expect(page).toHaveURL(/\/pc\/midia$/);
      await expect(bar(page)).toBeVisible();
      expect(await hiddenControls(page)).toEqual([]);
      await bar(page).getByRole('button', { name: 'Soltar' }).click();
      await expect.poll(releases).toEqual([{ key: 'ALT' }]);
    });

    test('em um agente antigo "Trocar janela" segue sendo um Alt+Tab de um toque, sem barra', async ({
      page,
    }) => {
      pc.status = { ...READY, apps: [...READY.apps] };
      await openPc(page);
      const sheet = await openSheet(page);
      await sheet.locator('[data-shortcut="switch-window"]').first().click();
      await expect.poll(keyBodies).toEqual([{ key: 'TAB', modifiers: ['ALT'] }]);
      await expect(bar(page)).toHaveCount(0);
      await expect(sheet).toBeVisible();
    });

    test('com o Alt segurado o botão do painel de teclas fica desligado: o painel não abre por cima da barra', async ({
      page,
    }) => {
      await openPc(page);
      await holdAlt(page);
      const more = page.getByRole('button', { name: 'Mais teclas', exact: true });
      await expect(more).toBeDisabled();
      await bar(page).getByRole('button', { name: 'Soltar' }).click();
      await expect(more).toBeEnabled();
    });

    test('depois de Soltar os botões da barra ficam desligados até terminar, e nenhum Tab sai depois', async ({
      page,
    }) => {
      await openPc(page);
      await holdAlt(page);
      pc.commandDelayMs = 300;
      await bar(page).getByRole('button', { name: 'Soltar' }).click();
      await expect(bar(page).getByRole('button', { name: /Próxima/ })).toBeDisabled();
      await expect(bar(page).getByRole('button', { name: /Anterior/ })).toBeDisabled();
      await expect.poll(releases).toEqual([{ key: 'ALT' }]);
      expect(keyBodies().filter((body) => body['key'] === 'TAB')).toHaveLength(1);
    });

    test.describe('o Alt nunca fica preso', () => {
      test('esconder a página (pagehide) solta o Alt', async ({ page }) => {
        await openPc(page);
        await holdAlt(page);
        await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        await expect.poll(releases).toEqual([{ key: 'ALT' }]);
        await expect(bar(page)).toHaveCount(0);
      });

      test('ir para o segundo plano solta o Alt', async ({ page }) => {
        await openPc(page);
        await holdAlt(page);
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', {
            value: 'hidden',
            configurable: true,
          });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await expect.poll(releases).toEqual([{ key: 'ALT' }]);
      });

      test('sair do módulo solta o Alt', async ({ page }) => {
        await openPc(page);
        await holdAlt(page);
        // Navegação de dentro do app (o roteador escuta o popstate): a tela do PC é destruída, sem recarregar a página.
        await page.evaluate(() => {
          history.pushState({}, '', '/');
          window.dispatchEvent(new PopStateEvent('popstate'));
        });
        await expect(page).not.toHaveURL(/\/pc/);
        await expect.poll(releases).toEqual([{ key: 'ALT' }]);
      });

      test('se o aperto do Alt falha, um soltar vai logo em seguida e a barra não fica', async ({
        page,
      }) => {
        await openPc(page);
        pc.commandFailure = { status: 504, kind: 'timeout' };
        pc.failOnly = (request) => request.path === '/key' && request.body?.['action'] === 'DOWN';
        const sheet = await openSheet(page);
        await sheet.locator('[data-shortcut="switch-window"]').first().click();
        await expect.poll(releases).toEqual([{ key: 'ALT' }]);
        await expect(bar(page)).toHaveCount(0);
        // O Tab que vinha atrás do aperto que falhou nunca sai sozinho.
        expect(keyBodies().filter((body) => body['key'] === 'TAB')).toEqual([]);
      });

      test('com o Alt segurado o sinal de vida do mouse segue (o agente não o solta por inatividade)', async ({
        page,
      }) => {
        await openPc(page);
        await holdAlt(page);
        await expect.poll(() => pc.sent('/pointer').length, { timeout: 15_000 }).toBeGreaterThan(0);
        expect(pc.sent('/pointer').every((body) => body['dx'] === 0 && body['dy'] === 0)).toBe(
          true,
        );
      });
    });
  });

  test.describe('o catálogo de atalhos novos', () => {
    const newer = ['zoom-in', 'zoom-out', 'zoom-reset', 'print-screen', 'context-menu'];

    test('um agente antigo não vê zoom, captura de tela, menu de contexto nem ir ao slide', async ({
      page,
    }) => {
      pc.status = { ...READY, apps: [...READY.apps] };
      await openPc(page, '/pc/atalhos');
      for (const id of [...newer, 'slides-goto']) {
        await expect(page.locator(`[data-shortcut="${id}"]`)).toHaveCount(0);
      }
      await expect(page.locator('[data-shortcut="screenshot"]')).toBeVisible();
    });

    test('com pc.key.v2 aparecem, e tocar manda a tecla nova com os modificadores', async ({
      page,
    }) => {
      await openPc(page, '/pc/atalhos');
      for (const id of newer) await page.locator(`[data-shortcut="${id}"]`).click();
      await expect
        .poll(keyBodies)
        .toEqual([
          { key: 'EQUALS', modifiers: ['CTRL'] },
          { key: 'MINUS', modifiers: ['CTRL'] },
          { key: 'D0', modifiers: ['CTRL'] },
          { key: 'PRINT_SCREEN' },
          { key: 'APPS' },
        ]);
    });

    test('ir ao slide N: o botão anuncia que abriu, o campo recebe o foco e manda os dígitos e o Enter', async ({
      page,
    }) => {
      await openPc(page, '/pc/atalhos');
      const cell = page.locator('[data-shortcut="slides-goto"]');
      await expect(cell).toHaveAttribute('aria-expanded', 'false');
      await cell.click();
      await expect(cell).toHaveAttribute('aria-expanded', 'true');
      const field = page.getByLabel('Número do slide');
      await expect(field).toBeFocused();
      await field.fill('12');
      await page.getByRole('button', { name: 'Ir', exact: true }).click();
      await expect.poll(keyBodies).toEqual([{ key: 'D1' }, { key: 'D2' }, { key: 'ENTER' }]);
    });

    test('ir ao slide N com um valor inválido mostra o nosso aviso (não o do navegador) e não manda nada', async ({
      page,
    }) => {
      await openPc(page, '/pc/atalhos');
      await page.locator('[data-shortcut="slides-goto"]').click();
      for (const bad of ['abc', '0', '']) {
        await page.getByLabel('Número do slide').fill(bad);
        await page.getByRole('button', { name: 'Ir', exact: true }).click();
        await expect(page.getByRole('alert')).toContainText('de 1 a 999');
      }
      expect(keyBodies()).toEqual([]);
    });
  });

  test('o título da folha de atalhos, focado por código, não mostra contorno', async ({ page }) => {
    await openPc(page);
    const sheet = await openSheet(page);
    const title = sheet.getByRole('heading', { name: 'Atalhos', exact: true });
    await expect(title).toBeFocused();
    const outline = await title.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(outline.style === 'none' || outline.width === '0px').toBe(true);
  });
});

test.describe('Texto e cliques do pc.text.v2 e do pc.click.v2', () => {
  const declared = (capabilities: string[]) => {
    pc.status = { ...READY, apps: [...READY.apps], capabilities };
  };
  const edits = () => pc.sent('/text');
  const typedText = () =>
    edits()
      .map((body) => String(body['text'] ?? ''))
      .join('');

  /** Arma o Ctrl pelo painel de teclas e fecha o painel, que cobriria a superfície do toque. */
  async function armCtrl(page: Page) {
    await page.getByRole('button', { name: 'Mais teclas', exact: true }).click();
    const panel = page.getByRole('group', { name: 'Mais teclas' }).last();
    await panel.getByRole('button', { name: 'Ctrl', exact: true }).click();
    await expect(page.locator('.armed')).toContainText('Ctrl');
    await page.getByRole('button', { name: 'Mais teclas', exact: true }).click();
    await expect(panel).toBeHidden();
  }

  async function openKeyboard(page: Page) {
    await page.getByRole('button', { name: 'Teclado', exact: true }).click();
    const field = page.getByLabel('Digitar no PC');
    await expect(field).toBeFocused();
    return field;
  }

  test.describe('digitação ao vivo num PC com pc.text.v2', () => {
    test.beforeEach(() => declared(['pc.key.v2', 'pc.text.v2']));

    test('apagar é um pedido de texto com o que apagar, sem Backspace por tecla', async ({
      page,
    }) => {
      await openPc(page);
      const field = await openKeyboard(page);
      await field.pressSequentially('abc');
      await expect.poll(typedText).toBe('abc');
      await field.press('Backspace');
      await expect.poll(() => edits().some((body) => body['erase'] === 1)).toBe(true);
      expect(pc.sent('/key')).toEqual([]);
    });

    test('uma palavra trocada é um pedido só: apagar e digitar juntos', async ({ page }) => {
      await openPc(page);
      const field = await openKeyboard(page);
      await field.pressSequentially('casa');
      await expect.poll(typedText).toBe('casa');
      const before = edits().length;
      // Selecionar tudo e digitar por cima: a diferença apaga o que havia e digita o novo, num pedido só.
      await field.press('ControlOrMeta+a');
      await page.keyboard.insertText('rua');
      await expect.poll(() => edits().length).toBe(before + 1);
      expect(edits().at(-1)).toEqual({ erase: 4, text: 'rua' });
      expect(pc.sent('/key')).toEqual([]);
    });

    test('um texto colado com várias linhas leva o Enter junto, no pedido do texto', async ({
      page,
    }) => {
      await openPc(page);
      await openKeyboard(page);
      await page.keyboard.insertText('um\ndois');
      await expect.poll(() => edits()).toEqual([{ text: 'um', key: 'ENTER' }, { text: 'dois' }]);
      expect(pc.sent('/key')).toEqual([]);
    });

    test('com a rede lenta uma rajada digitada e apagada custa poucos pedidos', async ({
      page,
    }) => {
      pc.commandDelayMs = 300;
      await openPc(page);
      const field = await openKeyboard(page);
      await field.pressSequentially('abcdefghij', { delay: 20 });
      await expect.poll(typedText).toBe('abcdefghij');
      const before = edits().length;
      // O primeiro apagar sai na hora; os dois seguintes chegam com ele em voo e saem juntos, num pedido só.
      await field.press('Backspace');
      await field.press('Backspace');
      await field.press('Backspace');
      await expect
        .poll(() => edits().reduce((sum, body) => sum + Number(body['erase'] ?? 0), 0))
        .toBe(3);
      expect(edits().length - before).toBeLessThanOrEqual(2);
      expect(pc.sent('/key')).toEqual([]);
    });
  });

  test('num PC sem pc.text.v2 apagar segue sendo uma tecla Backspace por caractere', async ({
    page,
  }) => {
    declared(['pc.key.v2']);
    await openPc(page);
    const field = await openKeyboard(page);
    await field.pressSequentially('ab');
    await expect.poll(typedText).toBe('ab');
    await field.press('Backspace');
    await expect.poll(() => pc.sent('/key')).toEqual([{ key: 'BACKSPACE' }]);
    expect(edits().some((body) => 'erase' in body)).toBe(false);
  });

  test.describe('toques num PC com pc.click.v2', () => {
    test.beforeEach(() => declared(['pc.key.v2', 'pc.click.v2']));

    test('o segundo toque de um toque duplo leva o intervalo medido desde o primeiro', async ({
      page,
    }) => {
      await openPc(page);
      const { x, y } = await padCenter(page);
      await fingers(page, [
        { type: 'down', id: 1, x, y },
        { type: 'up', id: 1, x, y, wait: 40 },
        { type: 'down', id: 1, x: x + 2, y, wait: 90 },
        { type: 'up', id: 1, x: x + 2, y, wait: 40 },
      ]);
      await expect.poll(() => pc.sent('/click').length).toBe(2);
      const [first, second] = pc.sent('/click');
      expect(first).toEqual({ button: 'LEFT' });
      expect(second).toMatchObject({ button: 'LEFT' });
      // O intervalo é entre as duas saídas do dedo: uns 130 ms (a espera real do navegador varia).
      expect(Number(second['gapMs'])).toBeGreaterThanOrEqual(100);
      expect(Number(second['gapMs'])).toBeLessThanOrEqual(300);
    });

    test('um toque comum não leva intervalo nem modificador', async ({ page }) => {
      await openPc(page);
      const { x, y } = await padCenter(page);
      await tap(page, x, y);
      await expect.poll(() => pc.sent('/click')).toEqual([{ button: 'LEFT' }]);
    });

    test('o Ctrl armado vale para o toque (Ctrl+clique) e se solta', async ({ page }) => {
      await openPc(page);
      await armCtrl(page);
      const { x, y } = await padCenter(page);
      await tap(page, x, y);
      await expect.poll(() => pc.sent('/click')).toEqual([{ button: 'LEFT', modifiers: ['CTRL'] }]);
      await expect(page.locator('.armed')).toHaveCount(0);
      // O toque seguinte (depois do tempo do toque duplo) já é comum.
      await page.waitForTimeout(450);
      await tap(page, x, y);
      await expect
        .poll(() => pc.sent('/click'))
        .toEqual([{ button: 'LEFT', modifiers: ['CTRL'] }, { button: 'LEFT' }]);
    });

    test('o Ctrl armado vale para os DOIS toques de um toque duplo, e o segundo leva o intervalo', async ({
      page,
    }) => {
      await openPc(page);
      await armCtrl(page);
      const { x, y } = await padCenter(page);
      await fingers(page, [
        { type: 'down', id: 1, x, y },
        { type: 'up', id: 1, x, y, wait: 40 },
        { type: 'down', id: 1, x: x + 2, y, wait: 90 },
        { type: 'up', id: 1, x: x + 2, y, wait: 40 },
      ]);
      await expect.poll(() => pc.sent('/click').length).toBe(2);
      const [first, second] = pc.sent('/click');
      expect(first).toEqual({ button: 'LEFT', modifiers: ['CTRL'] });
      expect(second).toMatchObject({ button: 'LEFT', modifiers: ['CTRL'] });
      expect(Number(second['gapMs'])).toBeGreaterThanOrEqual(100);
      await expect(page.locator('.armed')).toHaveCount(0);
      // Um toque comum depois, fora do tempo do toque duplo, já não leva o Ctrl.
      await page.waitForTimeout(450);
      await tap(page, x, y);
      await expect.poll(() => pc.sent('/click').length).toBe(3);
      expect(pc.sent('/click')[2]).toEqual({ button: 'LEFT' });
    });

    test('arrastar nunca leva modificador, mesmo com Ctrl armado', async ({ page }) => {
      await openPc(page);
      await armCtrl(page);
      const { x, y } = await padCenter(page);
      await longPress(page, x, y);
      await page.mouse.up();
      await expect
        .poll(() => pc.sent('/click'))
        .toEqual([
          { button: 'LEFT', action: 'DOWN' },
          { button: 'LEFT', action: 'UP' },
        ]);
    });
  });

  test('num PC sem pc.click.v2 o toque sai como sempre e o Ctrl armado segue armado', async ({
    page,
  }) => {
    declared(['pc.key.v2']);
    await openPc(page);
    await armCtrl(page);
    const { x, y } = await padCenter(page);
    await fingers(page, [
      { type: 'down', id: 1, x, y },
      { type: 'up', id: 1, x, y, wait: 40 },
      { type: 'down', id: 1, x: x + 2, y, wait: 90 },
      { type: 'up', id: 1, x: x + 2, y, wait: 40 },
    ]);
    await expect.poll(() => pc.sent('/click')).toEqual([{ button: 'LEFT' }, { button: 'LEFT' }]);
    await expect(page.locator('.armed')).toContainText('Ctrl');
  });
});
