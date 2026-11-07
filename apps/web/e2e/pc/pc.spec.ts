import { join } from 'node:path';
import { Page } from '@playwright/test';
import { GUEST, IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { PcMock, mockPcApi } from './pc-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints (o orquestrador aponta uma pasta); sem a variável, ficam em `test-results`. */
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

test.describe('Touchpad', () => {
  test('um dedo move o ponteiro, um toque clica e os botões fazem o mesmo', async ({ page }) => {
    await openPc(page);
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

    await page.getByRole('button', { name: 'Direito' }).click();
    await page.getByRole('button', { name: 'Esquerdo' }).click();
    await expect
      .poll(() => pc.sent('/click').map((body) => body['button']))
      .toEqual(['LEFT', 'RIGHT', 'LEFT']);
  });

  test('Arrastar segura o botão esquerdo até soltar', async ({ page }) => {
    await openPc(page);
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
    const drag = page.getByRole('button', { name: 'Arrastar' });
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(drag).toHaveAttribute('aria-pressed', 'true');
    // O aviso é forte e inconfundível: contorno cheio e a palavra, não só uma cor.
    await expect(page.locator('.pad.holding')).toBeVisible();
    await expect(page.getByText('Arrastando', { exact: true })).toBeVisible();
    expect(pc.sent('/click')).toEqual([{ button: 'LEFT', action: 'DOWN' }]);
    await page.mouse.move(x + 60, y + 20, { steps: 4 });
    await page.mouse.up();
    await expect(drag).toHaveAttribute('aria-pressed', 'false');
    expect(pc.sent('/click')).toEqual([
      { button: 'LEFT', action: 'DOWN' },
      { button: 'LEFT', action: 'UP' },
    ]);
    await expect.poll(() => pc.sent('/pointer').length).toBeGreaterThan(0);
  });

  test('esconder a página com o botão apertado solta o botão (pagehide)', async ({ page }) => {
    await openPc(page);
    const drag = page.getByRole('button', { name: 'Arrastar' });
    await drag.click();
    await expect(drag).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect
      .poll(() => pc.sent('/click'))
      .toEqual([
        { button: 'LEFT', action: 'DOWN' },
        { button: 'LEFT', action: 'UP' },
      ]);
    await expect(drag).toHaveAttribute('aria-pressed', 'false');
  });

  test('ir para o segundo plano com o botão apertado também solta', async ({ page }) => {
    await openPc(page);
    const drag = page.getByRole('button', { name: 'Arrastar' });
    await drag.click();
    await expect(drag).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect
      .poll(() => pc.sent('/click').map((body) => body['action']))
      .toEqual(['DOWN', 'UP']);
    await expect(drag).toHaveAttribute('aria-pressed', 'false');
  });

  test('trocar de aba com o botão apertado solta o botão', async ({ page }) => {
    await openPc(page);
    await page.getByRole('button', { name: 'Arrastar' }).click();
    await expect(page.getByRole('button', { name: 'Arrastar' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await tabs(page).getByRole('link', { name: 'Teclado' }).click();
    await expect(page).toHaveURL(/\/pc\/teclado$/);
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
    const drag = page.getByRole('button', { name: 'Arrastar' });
    await drag.click();
    await expect
      .poll(() => pc.sent('/click').map((body) => body['action']))
      .toEqual(['DOWN', 'UP']);
    await expect(drag).toHaveAttribute('aria-pressed', 'false');
    // O soltar passou (só o aperto falhou): a página ao esconder não tem mais nada a soltar, então nenhum pedido novo sai.
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.waitForTimeout(300);
    expect(pc.sent('/click').map((body) => body['action'])).toEqual(['DOWN', 'UP']);
    await expect(page.getByRole('alert')).toContainText('O PC não respondeu a tempo.');
  });

  test('os ajustes mudam a sensibilidade e ficam guardados neste aparelho', async ({ page }) => {
    await openPc(page);
    await page.getByRole('button', { name: 'Ajustes do touchpad' }).click();
    const sheet = page.getByRole('dialog', { name: 'Touchpad' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('radio', { name: 'Normal' })).toBeChecked();
    await sheet.getByRole('radio', { name: 'Alta' }).check();
    await sheet.getByRole('switch', { name: 'Inverter rolagem' }).check();
    await sheet.getByRole('button', { name: 'Fechar' }).click();
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
    const again = page.getByRole('dialog', { name: 'Touchpad' });
    await expect(again.getByRole('radio', { name: 'Alta' })).toBeChecked();
    await expect(again.getByRole('switch', { name: 'Inverter rolagem' })).toBeChecked();
  });

  test('cabe na tela, sem rolagem lateral, alvos de 44 px e sem falha de acessibilidade', async ({
    page,
  }) => {
    await openPc(page);
    await expectNoHorizontalScroll(page);
    expect(await smallTargets(page)).toEqual([]);
    await expectNoA11yViolations(page);
    await expect(tabs(page).getByRole('link')).toHaveText([
      'Touchpad',
      'Teclado',
      'Mídia',
      'Energia',
    ]);
  });

  test('print do Touchpad', async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openPc(page);
    await screenshot(page, join(SHOTS, `pc-touchpad-${info.project.name}.png`));
  });
});

test.describe('Teclado', () => {
  test('digita o texto inteiro (com acento), esvazia o campo e manda as teclas e os atalhos', async ({
    page,
  }) => {
    await openPc(page, '/pc/teclado');
    const field = page.getByLabel('Texto para digitar no PC');
    await field.fill('olá, mundo');
    await page.getByRole('button', { name: 'Digitar' }).click();
    await expect.poll(() => pc.sent('/text')).toEqual([{ text: 'olá, mundo' }]);
    await expect(field).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Digitar' })).toBeDisabled();

    await page.getByRole('button', { name: 'Enter', exact: true }).click();
    await page.getByRole('button', { name: 'Copiar' }).click();
    await page.getByRole('button', { name: 'Trocar Janela' }).click();
    await expect
      .poll(() => pc.sent('/key'))
      .toEqual([
        { key: 'ENTER' },
        { key: 'C', modifiers: ['CTRL'] },
        { key: 'TAB', modifiers: ['ALT'] },
      ]);
  });

  test('as teclas armadas valem para a próxima tecla e se soltam sozinhas', async ({ page }) => {
    await openPc(page, '/pc/teclado');
    const key = (name: string) => page.getByRole('button', { name, exact: true });
    const shift = key('Shift');
    await expect(shift).toHaveAttribute('aria-pressed', 'false');
    await shift.click();
    await expect(shift).toHaveAttribute('aria-pressed', 'true');
    await key('Enter').click();
    await expect(shift).toHaveAttribute('aria-pressed', 'false');
    await key('Enter').click();

    await key('Ctrl').click();
    await key('Alt').click();
    await key('Del (Delete)').click();

    await key('Win').click();
    await page.getByLabel('Texto para digitar no PC').fill('d');
    await page.getByRole('button', { name: 'Digitar' }).click();
    await expect
      .poll(() => pc.sent('/key'))
      .toEqual([
        { key: 'ENTER', modifiers: ['SHIFT'] },
        { key: 'ENTER' },
        { key: 'DELETE', modifiers: ['CTRL', 'ALT'] },
        { key: 'D', modifiers: ['WIN'] },
      ]);
    expect(pc.sent('/text')).toEqual([]);
    await expect(page.locator('.mods [aria-pressed="true"]')).toHaveCount(0);
  });

  test('as teclas F1 a F12 existem', async ({ page }) => {
    await openPc(page, '/pc/teclado');
    await page.getByRole('button', { name: 'F5', exact: true }).click();
    await expect.poll(() => pc.sent('/key')).toEqual([{ key: 'F5' }]);
  });

  test('o texto com emoji vai inteiro, e o limite conta pontos de código', async ({ page }) => {
    await openPc(page, '/pc/teclado');
    const field = page.getByLabel('Texto para digitar no PC');
    await field.fill('oi 😀 ação');
    await page.getByRole('button', { name: 'Digitar' }).click();
    await expect.poll(() => pc.sent('/text')).toEqual([{ text: 'oi 😀 ação' }]);

    await field.fill('😀'.repeat(200) + 'x');
    await expect(field).toHaveValue('😀'.repeat(200));
  });

  test('cabe na tela e não tem falha de acessibilidade', async ({ page }) => {
    await openPc(page, '/pc/teclado');
    await expectNoHorizontalScroll(page);
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
    await page.getByRole('button', { name: 'Esquerdo' }).click();
    await expect.poll(() => pc.sent('/click')).toEqual([{ button: 'LEFT' }]);
    expect(pc.denied).toEqual([]);
  });
});
