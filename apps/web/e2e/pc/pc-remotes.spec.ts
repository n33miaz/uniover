import { join } from 'node:path';
import { Page } from '@playwright/test';
import { IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
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
  await mockTvApi(context, identity);
  await installFakeEventSource(page);
  pc.status = { ...READY, apps: [...READY.apps], capabilities: ['pc.key.v2', 'pc.target.v1'] };
});

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Abas do módulo' });
const status = (page: Page) => page.getByRole('status').filter({ hasText: /Conectado|Sem/ });

async function openPc(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: 'Controle do PC' })).toBeVisible();
  await expect(status(page)).toHaveText('Conectado');
  await settle(page);
}

/** Um botão do controle aberto: os três grandes e os da grade têm o nome de quem lê a tela. */
const press = (page: Page, name: string) =>
  page.locator('app-pc-remote-pad').getByRole('button', { name, exact: true }).click();

/**
 * Cada controle: o nome na lista, o que tocar e o que o PC deve receber. Um botão grande e um da grade por controle (a
 * tabela inteira, botão a botão, está no teste de unidade).
 */
const CASES: readonly {
  name: string;
  slug: string;
  touches: readonly string[];
  keys: readonly Record<string, unknown>[];
  media?: readonly Record<string, unknown>[];
}[] = [
  {
    name: 'Navegador',
    slug: 'navegador',
    touches: ['Voltar', 'Nova Aba', 'Zoom +'],
    keys: [
      { key: 'LEFT', modifiers: ['ALT'], target: 'browser' },
      { key: 'T', modifiers: ['CTRL'], target: 'browser' },
      { key: 'EQUALS', modifiers: ['CTRL'], target: 'browser' },
    ],
  },
  {
    name: 'YouTube',
    slug: 'youtube',
    touches: ['Tocar ou pausar', 'Avançar 10 segundos', 'Legendas', 'Mais Rápido'],
    keys: [
      { key: 'K', target: 'browser' },
      { key: 'L', target: 'browser' },
      { key: 'C', target: 'browser' },
      { key: 'PERIOD', modifiers: ['SHIFT'], target: 'browser' },
    ],
  },
  {
    name: 'Netflix',
    slug: 'netflix',
    touches: ['Voltar 10 segundos', 'Pular Abertura'],
    keys: [
      { key: 'LEFT', target: 'browser' },
      { key: 'S', target: 'browser' },
    ],
  },
  {
    name: 'Spotify',
    slug: 'spotify',
    touches: ['Próxima faixa', 'Curtir'],
    keys: [{ key: 'B', modifiers: ['ALT', 'SHIFT'], target: 'spotify' }],
    media: [{ action: 'NEXT' }],
  },
  {
    name: 'VLC',
    slug: 'vlc',
    touches: ['Avançar 10 segundos', 'Volume +'],
    keys: [
      { key: 'RIGHT', modifiers: ['ALT'], target: 'vlc' },
      { key: 'UP', modifiers: ['CTRL'], target: 'vlc' },
    ],
  },
  {
    name: 'Teclado Numérico',
    slug: 'teclado-numerico',
    touches: ['4', '2', 'Enter'],
    keys: [{ key: 'D4' }, { key: 'D2' }, { key: 'ENTER' }],
  },
];

test.describe('Controles', () => {
  test('a tela Mais leva à lista e a aba Mais segue marcada', async ({ page }) => {
    await openPc(page, '/pc/mais');
    await page.getByRole('link', { name: 'Controles' }).click();
    await expect(page).toHaveURL(/\/pc\/controles$/);
    await expect(page.locator('a.row')).toHaveText(CASES.map((item) => item.name));
    await expect(tabs(page).getByRole('link', { name: 'Mais' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  for (const item of CASES) {
    test(`${item.name}: abre pela lista e cada toque manda a tecla certa`, async ({ page }) => {
      await openPc(page, '/pc/controles');
      await page.getByRole('link', { name: item.name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/pc/controles/${item.slug}$`));
      await expect(page.getByRole('heading', { level: 2, name: item.name })).toBeVisible();
      for (const touch of item.touches) await press(page, touch);
      await expect.poll(() => pc.sent('/key')).toEqual(item.keys);
      await expect.poll(() => pc.sent('/media')).toEqual(item.media ?? []);
      await expect(tabs(page).getByRole('link', { name: 'Mais' })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });
  }

  test('VLC: "mais rápido" sai digitado (o "+" não é tecla do contrato)', async ({ page }) => {
    await openPc(page, '/pc/controles/vlc');
    await press(page, 'Mais Rápido');
    await expect.poll(() => pc.sent('/text')).toEqual([{ text: '+', target: 'vlc' }]);
    expect(pc.sent('/key')).toEqual([]);
  });

  test('Navegador: a barra de endereço manda Ctrl+L, o texto e Enter', async ({ page }) => {
    await openPc(page, '/pc/controles/navegador');
    const field = page.getByRole('textbox', { name: 'Endereço ou pesquisa' });
    await field.fill('uniover.app');
    await page.getByRole('button', { name: 'Abrir no navegador' }).click();
    await expect.poll(() => pc.sent('/text').map((body) => body['text'])).toEqual(['uniover.app']);
    await expect
      .poll(() => pc.sent('/key'))
      .toEqual([
        { key: 'L', modifiers: ['CTRL'], target: 'browser' },
        { key: 'ENTER', target: 'browser' },
      ]);
    await expect(field).toHaveValue('');
  });

  test('com outro programa na frente nada sai e a linha diz qual abrir', async ({ page }) => {
    pc.commandFailure = {
      status: 502,
      kind: 'command-failed',
      extra: { agentError: 'app_not_in_front' },
    };
    pc.failOnly = (request) => request.path === '/key';
    await openPc(page, '/pc/controles/navegador');
    await page.getByRole('textbox', { name: 'Endereço ou pesquisa' }).fill('uniover.app');
    await page.getByRole('button', { name: 'Abrir no navegador' }).click();
    await expect(page.getByText('Abra o navegador no PC e deixe-o na frente.')).toBeVisible();
    // O Ctrl+L foi recusado: o texto e o Enter nem saíram.
    expect(pc.sent('/text')).toEqual([]);
    expect(pc.sent('/key')).toEqual([{ key: 'L', modifiers: ['CTRL'], target: 'browser' }]);
  });

  test('Fechar Aba: um toque só mostra a dica; segurar manda um Ctrl+W', async ({ page }) => {
    await openPc(page, '/pc/controles/navegador');
    const close = page.getByRole('button', { name: 'Fechar Aba', exact: true });
    await close.click();
    await expect(page.getByText('Segure para fechar')).toBeVisible();
    expect(pc.sent('/key')).toEqual([]);
    const box = (await close.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    await expect
      .poll(() => pc.sent('/key'))
      .toEqual([{ key: 'W', modifiers: ['CTRL'], target: 'browser' }]);
  });

  test('um PC que não confere o programa da frente: teclas desligadas, mídia segue', async ({
    page,
  }) => {
    pc.status = { ...READY, apps: [...READY.apps], capabilities: ['pc.key.v2'] };
    await openPc(page, '/pc/controles/spotify');
    await expect(page.getByText('Atualize o UniOver no PC para usar este controle.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Curtir', exact: true })).toBeDisabled();
    await press(page, 'Próxima faixa');
    await expect.poll(() => pc.sent('/media')).toEqual([{ action: 'NEXT' }]);
    expect(pc.sent('/key')).toEqual([]);
  });

  test('sem pc.key.v2 o teclado numérico some da lista e o zoom some do navegador', async ({
    page,
  }) => {
    pc.status = { ...READY, apps: [...READY.apps] };
    await openPc(page, '/pc/controles');
    await expect(page.locator('a.row')).toHaveCount(5);
    await expect(page.getByRole('link', { name: 'Teclado Numérico' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Navegador', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Voltar', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zoom +' })).toHaveCount(0);
  });

  test('a seta do cabeçalho é a única: do controle volta à lista, e da lista à aba Mais', async ({
    page,
  }) => {
    await openPc(page, '/pc/controles/spotify');
    // Nenhuma seta própria na tela: só a do cabeçalho do app.
    await expect(page.locator('main a')).toHaveCount(0);
    await page.getByRole('button', { name: 'Voltar aos Controles', exact: true }).click();
    await expect(page).toHaveURL(/\/pc\/controles$/);
    await page.getByRole('button', { name: 'Voltar a Mais', exact: true }).click();
    await expect(page).toHaveURL(/\/pc\/mais$/);
  });

  for (const path of ['/pc/controles', ...CASES.map((item) => `/pc/controles/${item.slug}`)]) {
    test(`${path}: cabe na tela, alvos de 44 px e sem falha de acessibilidade`, async ({
      page,
    }) => {
      await openPc(page, path);
      await expectNoHorizontalScroll(page);
      expect(await smallTargets(page)).toEqual([]);
      await expectNoA11yViolations(page);
    });
  }

  test('prints da lista e de um controle (tema escuro)', async ({ page }, info) => {
    test.skip(info.project.name !== 'iphone-12', 'um print só, no iPhone 12');
    await page.emulateMedia({ colorScheme: 'dark' });
    await openPc(page, '/pc/controles');
    await screenshot(page, join(SHOTS, `pc-controles-lista-${info.project.name}.png`));
    await page.getByRole('link', { name: 'YouTube', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Tocar ou pausar' })).toBeVisible();
    await settle(page);
    await screenshot(page, join(SHOTS, `pc-controles-youtube-${info.project.name}.png`));
  });
});
