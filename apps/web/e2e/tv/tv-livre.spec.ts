import { join } from 'node:path';
import { Locator, Page } from '@playwright/test';
import { GUEST, IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { LivreMock, jpegSize, livreView, mockLivreApi } from './livre-mock';
import { MockTv, TvMock, installFakeEventSource, mockTvApi } from './tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints (o orquestrador aponta uma pasta); sem a variável, nenhum print é feito. */
const SHOTS = process.env['TV_LIVRE_SHOTS'];

const SALA: MockTv = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Sala',
  isDefault: true,
  agentSlug: 'pc-sala',
  kind: 'android',
  online: true,
  capabilities: ['tv.remote', 'tv.kind.android', 'tv.adb', 'tv.livre.v1'],
};
const SAMSUNG: MockTv = {
  ...SALA,
  name: 'Samsung',
  kind: 'samsung',
  capabilities: ['tv.remote', 'tv.kind.samsung', 'tv.key.v3'],
};

let identity: IdentityMock;
let tv: TvMock;
let livre: LivreMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  tv = await mockTvApi(context, identity);
  // Depois do mock da TV: o Playwright atende primeiro a rota registrada por último.
  livre = await mockLivreApi(context, identity);
  await installFakeEventSource(page);
  identity.loggedIn = true;
  tv.tvs = [{ ...SALA }];
  // Os nomes dos apps vêm dos atalhos que a TV já guarda; o quarto app não tem atalho (o nome sai do pacote).
  ['Filmes', 'Música', 'Jogos'].forEach((name, index) => (tv.shortcuts[index].tvLabel = name));
  for (const [index, shortcut] of tv.shortcuts.entries()) {
    shortcut.package = `exemplo.pacote.app${index + 1}`;
  }
});

function signInAsGuest(permissions: string[]) {
  identity.guests.push({
    id: '00000000-0000-4000-8000-000000000051',
    displayName: GUEST.displayName,
    email: GUEST.email,
    password: GUEST.password,
    createdAt: '2026-10-19T15:00:00Z',
    disabledAt: null,
    permissions,
  });
  identity.role = 'guest';
}

const tabs = (page: Page) => page.getByRole('tablist', { name: 'Telas do TV Livre' });
const tab = (page: Page, name: string) => tabs(page).getByRole('tab', { name, exact: true });
const button = (root: Page | Locator, name: string) =>
  root.getByRole('button', { name, exact: true });
const preview = (page: Page) => page.locator('app-livre-preview');
const previewNames = (page: Page) => preview(page).locator('.name');
const applyBar = (page: Page) => page.locator('.ui-action-bar');

async function openLivre(page: Page, tabName = 'Home da TV') {
  await page.goto('/tv/livre');
  await expect(page.getByRole('heading', { level: 1, name: 'TV Livre' })).toBeVisible();
  await expect(tabs(page)).toBeVisible();
  if (tabName !== 'Home da TV') await tab(page, tabName).click();
  await expect(tab(page, tabName)).toHaveAttribute('aria-selected', 'true');
  await settle(page);
}

async function useScheme(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
  await settle(page);
}

/**
 * Alvos de toque com menos de 44 px. Os campos escondidos de verdade (rádio, arquivo) ficam de fora: o alvo deles é o
 * rótulo que os envolve, conferido à parte.
 */
async function expectBigTargets(page: Page) {
  const small = (await smallTargets(page)).filter((line) => !/^input "" 1x1$/.test(line));
  expect(small).toEqual([]);
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found, 'sem caixa na tela').not.toBeNull();
  return found!;
}

test.describe('o cartão na Início', () => {
  test('aparece para o dono quando a TV declara o TV Livre e leva à tela', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('article[data-module="tv-livre"]');
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { name: 'TV Livre' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await card.getByRole('link', { name: 'TV Livre: Configurar' }).click();
    await expect(page).toHaveURL(/\/tv\/livre$/);
    await expect(page.getByRole('heading', { level: 1, name: 'TV Livre' })).toBeVisible();
  });

  test('não aparece para uma TV que não declara o TV Livre (a Samsung)', async ({ page }) => {
    tv.tvs = [{ ...SAMSUNG }];
    const listed = page.waitForResponse((response) => response.url().includes('/api/v1/tv/tvs'));
    await page.goto('/');
    await listed;
    await expect(page.locator('article[data-module="tv"]')).toBeVisible();
    await settle(page);
    await expect(page.locator('article[data-module="tv-livre"]')).toHaveCount(0);
    expect(livre.requests).toEqual([]);
  });

  test('não aparece para o convidado, e o endereço da tela o leva de volta à Início', async ({
    page,
  }) => {
    signInAsGuest(['module:tv', 'tv:control']);
    await page.goto('/');
    await expect(page.locator('article[data-module="tv"]')).toBeVisible();
    await expect(page.locator('article[data-module="tv-livre"]')).toHaveCount(0);
    await page.goto('/tv/livre');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('article[data-module="tv"]')).toBeVisible();
    expect(livre.requests).toEqual([]);
    expect(tv.requests.some((r) => r.path === '/tvs')).toBe(false);
  });
});

test.describe('Home da TV', () => {
  test('mostra a pré-visualização fiel ao launcher: relógio e fileira de círculos centralizados', async ({
    page,
  }) => {
    await openLivre(page);
    const frame = preview(page).locator('.frame');
    const frameBox = await box(frame);
    expect(frameBox.width / frameBox.height).toBeCloseTo(16 / 9, 1);

    await expect(preview(page).locator('.time')).toHaveText(/^\d{2}:\d{2}$/);
    await expect(preview(page).locator('.date')).not.toBeEmpty();
    // Sem escolha, a Home mostra os apps que não são de fábrica, por nome.
    await expect(previewNames(page)).toHaveText(['Cinema', 'Filmes', 'Jogos', 'Música']);
    await expect(preview(page)).not.toContainText('UniOver');

    // Os círculos são redondos (largura = altura, raio de 50%), e o relógio e a fileira ficam no eixo da tela.
    const icons = preview(page).locator('app-tv-app-icon');
    await expect(icons).toHaveCount(4);
    for (const icon of await icons.all()) {
      const size = await box(icon);
      expect(size.width).toBeCloseTo(size.height, 0);
      expect(await icon.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('50%');
    }
    const center = frameBox.x + frameBox.width / 2;
    const time = await box(preview(page).locator('.time'));
    expect(time.x + time.width / 2).toBeCloseTo(center, 0);
    const row = await box(preview(page).locator('.row'));
    expect(row.x + row.width / 2).toBeCloseTo(center, 0);
    await expectNoHorizontalScroll(page);
  });

  test('lista qualquer app instalado, com os de fábrica recolhidos e desligados', async ({
    page,
  }) => {
    await openLivre(page);
    const names = page.locator('.app .name');
    await expect(names).toHaveText(['Cinema', 'Filmes', 'Jogos', 'Música']);
    const fold = page.getByRole('button', { name: /De Fábrica/ });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#livre-factory')).toHaveCount(0);
    await fold.click();
    await expect(page.locator('#livre-factory .name')).toHaveText(['Musica', 'Player']);
    for (const toggle of await page.locator('#livre-factory input[role="switch"]').all()) {
      await expect(toggle).not.toBeChecked();
    }
  });

  test('escolhe e ordena os apps, e "Aplicar na TV" guarda a configuração e depois aplica', async ({
    page,
  }) => {
    await openLivre(page);
    await page.getByRole('switch', { name: 'Mostrar Música na Home' }).check();
    await page.getByRole('switch', { name: 'Mostrar Filmes na Home' }).check();
    await expect(previewNames(page)).toHaveText(['Música', 'Filmes']);

    await button(page, 'Subir Filmes').click();
    await expect(previewNames(page)).toHaveText(['Filmes', 'Música']);
    await expect(button(page, 'Subir Filmes')).toBeDisabled();
    await expect(button(page, 'Descer Música')).toBeDisabled();

    await button(applyBar(page), 'Aplicar na TV').click();
    await expect(applyBar(page).getByRole('status')).toHaveText('Aplicado na TV.');

    expect(livre.to('PUT', '/config')).toHaveLength(1);
    expect(livre.to('PUT', '/config')[0].body).toMatchObject({
      apps: {
        mode: 'listed',
        items: ['exemplo.pacote.app1', 'exemplo.pacote.app2'],
        hidden: [],
        showFactory: false,
      },
      wallpaper: { type: 'gradient' },
    });
    expect(livre.to('POST', '/apply')).toHaveLength(1);
    // Guarda primeiro, aplica depois.
    const order = livre.requests.map((r) => `${r.method} ${r.path}`);
    expect(order.indexOf('PUT /config')).toBeLessThan(order.indexOf('POST /apply'));
    await expect(button(applyBar(page), 'Aplicar na TV')).toBeEnabled();
  });

  test('sem nenhum app escolhido manda "all" com a fábrica oculta', async ({ page }) => {
    await openLivre(page);
    await button(applyBar(page), 'Aplicar na TV').click();
    await expect(applyBar(page).getByRole('status')).toHaveText('Aplicado na TV.');
    expect(livre.to('PUT', '/config')[0].body).toMatchObject({
      apps: { mode: 'all', items: [], showFactory: false },
    });
  });

  test('um app de fábrica só entra na Home quando a pessoa o escolhe', async ({ page }) => {
    await openLivre(page);
    await page.getByRole('button', { name: /De Fábrica/ }).click();
    await page.getByRole('switch', { name: 'Mostrar Player na Home' }).check();
    await expect(previewNames(page)).toHaveText(['Player']);
  });

  test('mostra o esqueleto enquanto o estado não chega', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/api\/v1\/tv\/livre$/, async (route) => {
      await gate;
      await route.fallback();
    });
    await page.goto('/tv/livre');
    await expect(page.getByRole('heading', { level: 1, name: 'TV Livre' })).toBeVisible();
    await expect(page.locator('app-loading-frame')).toBeAttached();
    await expect(tabs(page)).toHaveCount(0);
    release();
    await expect(tabs(page)).toBeVisible();
    await expect(page.locator('app-loading-frame')).toHaveCount(0);
  });
});

test.describe('Fundo', () => {
  test('troca as cores do degradê pela combinação pronta e pelo seletor de cor, e aplica', async ({
    page,
  }) => {
    await openLivre(page, 'Fundo');
    const stage = preview(page).locator('.stage');
    const background = () => stage.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(await background()).toContain('rgb(27, 36, 64)');

    await page.getByRole('button', { name: 'Cores Oceano' }).click();
    await expect(page.getByRole('button', { name: 'Cores Oceano' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await background()).toContain('rgb(15, 43, 70)');
    expect(await background()).toContain('rgb(31, 111, 139)');

    await page.getByLabel('Cor Final').fill('#aa0000');
    await expect.poll(background).toContain('rgb(170, 0, 0)');
    // A cor escolhida à mão não é mais nenhuma das combinações prontas.
    await expect(page.locator('.preset[aria-pressed="true"]')).toHaveCount(0);

    await button(applyBar(page), 'Aplicar na TV').click();
    await expect(applyBar(page).getByRole('status')).toHaveText('Aplicado na TV.');
    expect(livre.to('PUT', '/config')[0].body).toMatchObject({
      wallpaper: { type: 'gradient', colors: ['#0f2b46', '#aa0000'], angle: 315 },
    });
  });

  test('reduz a foto no navegador para caber em 1920x1080 e 400 KB, envia e permite remover', async ({
    page,
  }) => {
    // Guarda o que a página envia: o WebKit não mostra ao Playwright o corpo binário de um Blob.
    await page.addInitScript(() => {
      const real = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (init?.method === 'PUT' && String(input).includes('/tv/livre/photo')) {
          const body = init.body as Blob;
          const bytes = new Uint8Array(await body.arrayBuffer());
          let binary = '';
          for (const byte of bytes) binary += String.fromCharCode(byte);
          (window as unknown as Record<string, unknown>)['__sentPhoto'] = btoa(binary);
        }
        return real(input, init);
      };
    });
    await openLivre(page, 'Fundo');
    await page.locator('label.kind', { hasText: 'Foto' }).click();
    await expect(page.getByText('Sem foto, o fundo fica em degradê.')).toBeVisible();

    // Uma foto grande de verdade (3000x2000, com ruído para o JPEG não sair pequeno), feita no próprio navegador.
    const jpeg = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 3000;
      canvas.height = 2000;
      const context = canvas.getContext('2d')!;
      const image = context.createImageData(3000, 2000);
      for (let i = 0; i < image.data.length; i += 4) {
        const noise = ((i * 2654435761) >>> 24) & 63;
        image.data[i] = ((i >> 12) & 255) ^ noise;
        image.data[i + 1] = (noise * 4) & 255;
        image.data[i + 2] = (i >> 14) & 255;
        image.data[i + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      return canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: 'foto.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from(jpeg, 'base64'),
    });

    await expect(applyBar(page).getByRole('status')).toHaveText('Foto salva.');
    const sent = livre.to('PUT', '/photo');
    expect(sent).toHaveLength(1);
    expect(sent[0].contentType).toBe('image/jpeg');
    const bytes = Buffer.from(
      await page.evaluate(() => (window as unknown as Record<string, string>)['__sentPhoto']),
      'base64',
    );
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
    expect(bytes.length).toBeLessThanOrEqual(400_000);
    const size = jpegSize(bytes)!;
    expect(size.width).toBeLessThanOrEqual(1920);
    expect(size.height).toBeLessThanOrEqual(1080);
    // A proporção 3:2 se mantém.
    expect(size.width / size.height).toBeCloseTo(1.5, 1);

    // A foto vira o fundo da pré-visualização, e o escurecimento aparece.
    await expect(preview(page).locator('img.photo')).toBeVisible();
    const dim = page.getByRole('slider');
    await dim.fill('40');
    await expect(preview(page).locator('.dim')).toHaveCSS('opacity', '0.4');

    await button(applyBar(page), 'Aplicar na TV').click();
    await expect(applyBar(page).getByRole('status')).toHaveText('Aplicado na TV.');
    expect(livre.to('PUT', '/config')[0].body).toMatchObject({
      wallpaper: { type: 'photo', dim: 0.4 },
    });

    await button(page, 'Remover Foto').click();
    await expect(applyBar(page).getByRole('status')).toHaveText('Foto removida.');
    expect(livre.to('DELETE', '/photo')).toHaveLength(1);
    await expect(preview(page).locator('img.photo')).toHaveCount(0);
  });

  test('mostra a foto guardada ao abrir, vinda do servidor', async ({ page }) => {
    // Um JPEG mínimo e válido: o navegador só precisa aceitá-lo como imagem.
    livre.photo = Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
      'base64',
    );
    livre.view = livreView({
      hasPhoto: true,
      config: {
        ...(livreView()['config'] as object),
        wallpaper: { type: 'photo', colors: ['#1b2440', '#3a2d5c'], angle: 315, dim: 0.25 },
      },
    });
    await openLivre(page, 'Fundo');
    await expect(preview(page).locator('img.photo')).toBeAttached();
    await expect(button(page, 'Remover Foto')).toBeVisible();
    expect(livre.to('GET', '/photo')).toHaveLength(1);
  });
});

test.describe('Dormir', () => {
  test('manda a TV dormir e explica que qualquer tecla a acorda', async ({ page }) => {
    await openLivre(page, 'Dormir');
    await expect(page.getByText('Qualquer tecla do controle acorda a TV.')).toBeVisible();
    const sleep = button(page, 'Modo Dormir');
    const size = await box(sleep);
    expect(size.height).toBeGreaterThanOrEqual(88);
    await sleep.click();
    await expect(applyBar(page).getByRole('status')).toContainText('Modo Dormir enviado');
    expect(livre.to('POST', '/sleep')).toHaveLength(1);
  });

  test('o tempo para acordar sozinho vai na configuração', async ({ page }) => {
    await openLivre(page, 'Dormir');
    await page.getByLabel('Acordar Sozinho (Minutos)').fill('90');
    await page.getByLabel('Acordar Sozinho (Minutos)').blur();
    await button(applyBar(page), 'Aplicar na TV').click();
    await expect(applyBar(page).getByRole('status')).toHaveText('Aplicado na TV.');
    expect(livre.to('PUT', '/config')[0].body).toMatchObject({ sleep: { maxMinutes: 90 } });
  });
});

test.describe('Instalação', () => {
  test('"Voltar ao Original" fica sempre à vista numa TV compatível, em qualquer estado', async ({
    page,
  }) => {
    for (const state of [
      { installed: false, isHome: false },
      { installed: true, isHome: false },
      { installed: true, isHome: true },
    ]) {
      livre.view = livreView(state);
      await openLivre(page, 'Instalação');
      await expect(button(page, 'Voltar ao Original')).toBeVisible();
      await expect(button(page, 'Voltar ao Original')).toBeEnabled();
    }
  });

  test('segue a ordem segura: instalar, depois definir como padrão (com a fábrica ligada por padrão)', async ({
    page,
  }) => {
    await openLivre(page, 'Instalação');
    await expect(page.locator('.status')).toContainText('Não');
    await expect(button(page, 'Definir Como Padrão')).toBeDisabled();

    await button(page, 'Instalar').click();
    await expect(page.getByRole('status').filter({ hasText: 'TV Livre instalado.' })).toBeVisible();
    await expect(page.locator('.status')).toContainText('Versão 0.1.0');
    await expect(button(page, 'Definir Como Padrão')).toBeEnabled();

    // A opção de desativar o launcher de fábrica começa desligada.
    const factory = page.getByRole('switch', { name: 'Desativar o Launcher de Fábrica' });
    await expect(factory).not.toBeChecked();
    await button(page, 'Definir Como Padrão').click();
    await expect(
      page.getByRole('status').filter({ hasText: 'TV Livre é a tela inicial.' }),
    ).toBeVisible();
    expect(livre.to('POST', '/set-home')[0].body).toEqual({ disableFactory: false });
    await expect(button(page, 'Definir Como Padrão')).toBeDisabled();
  });

  test('desativar o launcher de fábrica só acontece quando a pessoa liga a opção', async ({
    page,
  }) => {
    livre.view = livreView({ installed: true, version: '0.1.0' });
    await openLivre(page, 'Instalação');
    await page.getByRole('switch', { name: 'Desativar o Launcher de Fábrica' }).check();
    await button(page, 'Definir Como Padrão').click();
    await expect(
      page.getByRole('status').filter({ hasText: 'TV Livre é a tela inicial.' }),
    ).toBeVisible();
    expect(livre.to('POST', '/set-home')[0].body).toEqual({ disableFactory: true });
  });

  test('pede confirmação antes de voltar ao original, e só então manda', async ({ page }) => {
    livre.view = livreView({ installed: true, isHome: true, version: '0.1.0' });
    await openLivre(page, 'Instalação');
    await button(page, 'Voltar ao Original').click();
    await expect(
      page.getByText('Voltar à tela de fábrica e desinstalar o TV Livre?'),
    ).toBeVisible();
    // O foco vai para o lado seguro.
    await expect(button(page, 'Cancelar')).toBeFocused();
    expect(livre.to('POST', '/restore')).toHaveLength(0);

    await button(page, 'Cancelar').click();
    expect(livre.to('POST', '/restore')).toHaveLength(0);
    await expect(button(page, 'Voltar ao Original')).toBeFocused();

    await button(page, 'Voltar ao Original').click();
    await button(page, 'Voltar ao Original').click();
    await expect(
      page.getByRole('status').filter({ hasText: 'A TV voltou ao original.' }),
    ).toBeVisible();
    expect(livre.to('POST', '/restore')).toHaveLength(1);
    expect(livre.to('POST', '/restore')[0].body).toEqual({ uninstall: true });
    await expect(page.locator('.status')).toContainText('Não');
    await expect(button(page, 'Voltar ao Original')).toBeVisible();
  });

  test('Atualizar pede o estado de agora ao agente', async ({ page }) => {
    await openLivre(page, 'Instalação');
    livre.view = livreView({ installed: true, isHome: true, version: '0.2.0' });
    await button(page, 'Atualizar').click();
    await expect(page.locator('.status')).toContainText('Versão 0.2.0');
    expect(livre.to('POST', '/refresh')).toHaveLength(1);
  });
});

test.describe('erros', () => {
  test('o código do agente vira uma frase curta, e a saída continua à vista', async ({ page }) => {
    livre.failures['/install'] = {
      status: 502,
      kind: 'command-failed',
      agentError: 'signature_mismatch',
    };
    await openLivre(page, 'Instalação');
    await button(page, 'Instalar').click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText(
      'A versão instalada tem outra assinatura. Volte ao original e instale de novo.',
    );
    await expect(alert).not.toContainText('signature_mismatch');
    await expect(button(page, 'Voltar ao Original')).toBeEnabled();
  });

  test('guardou mas a TV não aplicou: diz que ficou salvo', async ({ page }) => {
    livre.failures['/apply'] = { status: 502, kind: 'command-failed', agentError: 'push_failed' };
    await openLivre(page);
    await button(applyBar(page), 'Aplicar na TV').click();
    await expect(applyBar(page).getByRole('alert')).toHaveText(
      'Salvo, mas a TV não aplicou. Não deu para enviar os arquivos à TV.',
    );
    expect(livre.to('PUT', '/config')).toHaveLength(1);
    await expect(button(applyBar(page), 'Aplicar na TV')).toBeEnabled();
  });

  test('a TV sem a capacidade recusada pelo servidor vira "não é compatível"', async ({ page }) => {
    livre.failures['/install'] = { status: 409, kind: 'tv-livre-unsupported' };
    await openLivre(page, 'Instalação');
    await button(page, 'Instalar').click();
    await expect(page.getByRole('alert')).toHaveText('Esta TV não é compatível com o TV Livre.');
  });

  test('uma TV incompatível mostra só o motivo, sem nada para mexer', async ({ page }) => {
    livre.view = livreView({ supported: false });
    await openLivre(page);
    await expect(page.getByText('Esta TV não é compatível com o TV Livre.')).toBeVisible();
    await expect(button(page, 'Aplicar na TV')).toHaveCount(0);
    await tab(page, 'Instalação').click();
    await expect(button(page, 'Voltar ao Original')).toHaveCount(0);
    await expect(button(page, 'Instalar')).toHaveCount(0);
  });

  test('o agente fora do ar desliga as ações, mas "Voltar ao Original" segue à vista', async ({
    page,
  }) => {
    livre.view = livreView({ available: false });
    await openLivre(page);
    await expect(page.getByText('O agente da TV está fora do ar.')).toBeVisible();
    await expect(button(applyBar(page), 'Aplicar na TV')).toHaveCount(0);
    await tab(page, 'Instalação').click();
    await expect(button(page, 'Voltar ao Original')).toBeVisible();
    await expect(button(page, 'Voltar ao Original')).toBeDisabled();
    await expect(button(page, 'Instalar')).toBeDisabled();
    livre.view = livreView({ available: true });
    await button(page, 'Tentar de Novo').click();
    await expect(button(page, 'Instalar')).toBeEnabled();
  });

  test('a primeira leitura que falha mostra uma frase e "Tentar de Novo"', async ({ page }) => {
    livre.failures['/'] = { status: 503, kind: 'agent-offline' };
    await page.goto('/tv/livre');
    await expect(page.getByRole('alert')).toContainText('agente da TV');
    delete livre.failures['/'];
    await button(page, 'Tentar de Novo').click();
    await expect(tabs(page)).toBeVisible();
  });
});

test.describe('a tela inteira', () => {
  test('as abas se movem pelo teclado', async ({ page }) => {
    await openLivre(page);
    await tab(page, 'Home da TV').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'Fundo')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Fundo')).toBeFocused();
    await page.keyboard.press('End');
    await expect(tab(page, 'Instalação')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tab(page, 'Home da TV')).toBeFocused();
  });

  for (const name of ['Home da TV', 'Fundo', 'Dormir', 'Instalação']) {
    test(`${name}: sem rolagem lateral, alvos de 44 px e sem violação de acessibilidade nos dois temas`, async ({
      page,
    }) => {
      livre.view = livreView({ installed: true, version: '0.1.0' });
      await openLivre(page, name);
      // Os rótulos das abas ficam numa linha só.
      for (const label of ['Home da TV', 'Fundo', 'Dormir', 'Instalação']) {
        const height = (await box(tab(page, label))).height;
        expect(height, label).toBeLessThan(56);
        expect(await tab(page, label).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(
          true,
        );
      }
      await expectNoHorizontalScroll(page);
      await expectBigTargets(page);
      for (const scheme of ['light', 'dark'] as const) {
        await useScheme(page, scheme);
        await expectNoA11yViolations(page);
      }
    });
  }

  test('Fundo com foto: os rótulos escondidos têm alvo de 44 px', async ({ page }) => {
    await openLivre(page, 'Fundo');
    for (const label of await page.locator('label.kind, label.pick').all()) {
      expect((await box(label)).height).toBeGreaterThanOrEqual(43.5);
    }
    await page.locator('label.kind', { hasText: 'Foto' }).click();
    await expect(page.locator('label.pick')).toBeVisible();
    expect((await box(page.locator('label.pick'))).height).toBeGreaterThanOrEqual(43.5);
    await expectBigTargets(page);
    for (const scheme of ['light', 'dark'] as const) {
      await useScheme(page, scheme);
      await expectNoA11yViolations(page);
    }
  });
});

test.describe('prints', () => {
  test.skip(!SHOTS, 'defina TV_LIVRE_SHOTS para gravar os prints');

  test('Home da TV e Fundo, no iPhone 12, tema claro', async ({ page }, info) => {
    test.skip(info.project.name !== 'iphone-12', 'só o iPhone 12');
    livre.view = livreView({ installed: true, version: '0.1.0' });
    await openLivre(page);
    await useScheme(page, 'light');
    await screenshot(page, join(SHOTS!, 'tvlivre-home-da-tv.png'));
    await tab(page, 'Fundo').click();
    await expect(tab(page, 'Fundo')).toHaveAttribute('aria-selected', 'true');
    await settle(page);
    await screenshot(page, join(SHOTS!, 'tvlivre-fundo.png'));
  });
});
