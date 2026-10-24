import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Locator, Page } from '@playwright/test';
import { GUEST, IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import {
  HOT_STATE,
  MockShortcut,
  TvMock,
  emitSse,
  installFakeEventSource,
  mockTvApi,
  sseUrls,
} from './tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints do revisor (o orquestrador aponta uma pasta); sem a variável, ficam em `test-results`. */
const SHOTS = process.env['TV_MENU_SHOTS'] ?? 'test-results';

/** As duas telas de referência: o iPhone 12 instalado e um Android comum (retrato). */
const SCREENS = [
  { name: '390x664', width: 390, height: 664 },
  { name: '360x740', width: 360, height: 740 },
] as const;

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

/** Uma convidada com a lista dada, como o `/me` a devolveria (a sessão já aberta). */
function signInAsGuest(permissions: readonly string[]) {
  identity.guests.push({
    id: '00000000-0000-4000-8000-000000000061',
    displayName: GUEST.displayName,
    email: GUEST.email,
    password: GUEST.password,
    createdAt: '2026-10-19T15:00:00Z',
    disabledAt: null,
    permissions: [...permissions],
  });
  identity.role = 'guest';
  identity.loggedIn = true;
}

async function showTv(page: Page, title = 'TV') {
  await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
  await emitSse(page, 'tv.state', tv.state);
  await emitSse(page, 'tv.shortcuts', tv.shortcuts);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await settle(page);
}

async function openTv(page: Page) {
  await signIn(page);
  await page.goto('/tv');
  await showTv(page);
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeVisible();
}

/** Põe o tema do sistema e o movimento reduzido, e espera o app copiar o tema para `data-theme`. */
async function useScheme(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
  await settle(page);
}

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const header = (page: Page) => page.locator('header.head');
const menuButton = (page: Page) => header(page).getByRole('button', { name: 'Mais opções' });
const menuDialog = (page: Page) => page.getByRole('dialog', { name: 'Mais opções' });
const appsDialog = (page: Page) => page.getByRole('dialog', { name: 'Apps da TV' });

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found, 'elemento sem caixa na tela').not.toBeNull();
  return found!;
}

async function expectNoVerticalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  expect(overflow, 'a tela não pode rolar na vertical').toBeLessThanOrEqual(0);
}

async function shoot(page: Page, name: string, project: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await useScheme(page, scheme);
    await screenshot(page, join(SHOTS, `${name}-${scheme}-${project}.png`));
  }
}

/** Sem axe, sem alvo de toque pequeno e sem rolagem horizontal, nos dois temas. */
async function expectSound(page: Page) {
  await expectNoHorizontalScroll(page);
  expect(await smallTargets(page)).toEqual([]);
  for (const scheme of ['light', 'dark'] as const) {
    await useScheme(page, scheme);
    await expectNoA11yViolations(page);
  }
}

const pending = (
  position: number,
  tvLabel: string,
  pkg: string,
  extra: Partial<MockShortcut> = {},
): MockShortcut => ({
  id: `00000000-0000-4000-8000-0000000001${String(position).padStart(2, '0')}`,
  position,
  package: pkg,
  tvLabel,
  customLabel: null,
  enabled: false,
  installed: true,
  ...extra,
});

for (const screen of SCREENS) {
  test.describe(`controle em ${screen.name}`, () => {
    test.use({ viewport: { width: screen.width, height: screen.height } });

    test('cabe sem rolagem, o direcional ocupa mais e os pontos continuam com alvo de 44 px', async ({
      page,
    }, info) => {
      await openTv(page);
      await expectNoVerticalScroll(page);
      await expectNoHorizontalScroll(page);

      const dots = await box(page.locator('app-page-dots .dot').first());
      expect(dots.height, 'alvo do ponto').toBeGreaterThanOrEqual(44);
      // O bloco dos pontos ocupa menos do que os 44 px do alvo: a sobra de altura é do anel.
      const block = await box(page.locator('app-page-dots'));
      expect(block.height, 'altura que o bloco dos pontos ocupa no fluxo').toBeLessThanOrEqual(44);
      const ring = await box(page.locator('div.ring'));
      const bottom = await box(page.locator('.bottom'));
      // Anel, pontos e botões de baixo não se sobrepõem em nada que se toque: o alvo do ponto termina onde o bloco de baixo começa.
      expect(dots.y + dots.height, 'o ponto não passa para cima dos botões').toBeLessThanOrEqual(
        bottom.y + 0.5,
      );
      expect(ring.width).toBeGreaterThanOrEqual(300);
      // O alvo do ponto não invade a janela do palco: não toma o toque da borda do anel.
      const stage = await box(page.locator('.viewport'));
      expect(dots.y, 'o alvo do ponto começa onde o palco termina').toBeGreaterThanOrEqual(
        stage.y + stage.height - 0.5,
      );
      // Os números ficam ao lado dos prints, para o revisor ler (o direcional media 318 px antes, em 390x664).
      writeFileSync(
        join(SHOTS, `medidas-${screen.name}-${info.project.name}.json`),
        JSON.stringify(
          {
            tela: screen,
            anel: ring,
            janelaDoPalco: await box(page.locator('.viewport')),
            pontosBloco: block,
            pontosAlvo: dots,
            fileiraDeBaixo: bottom,
            atalhos: await box(page.locator('app-tv-shortcut-row .top')),
          },
          null,
          1,
        ),
      );

      await shoot(page, `controle-${screen.name}`, info.project.name);
    });

    test('com o agente fora do ar o controle fica apagado, sem rolagem, e a ação é uma só', async ({
      page,
    }, info) => {
      await openTv(page);
      await emitSse(page, 'tv.state', {
        ...HOT_STATE,
        agentOnline: false,
        connection: 'disconnected',
        volume: null,
      });
      const row = page.locator('.reason-row');
      await expect(row).toBeVisible();
      await expect(row.getByText('O agente da TV está desligado')).toBeVisible();
      const retry = row.getByRole('button', { name: 'Tentar de novo' });
      await expect(retry).toBeVisible();
      expect((await box(retry)).height).toBeGreaterThanOrEqual(44);

      // Nenhum botão de comando parece pronto: tudo o que manda algo à TV está apagado.
      for (const name of ['OK', 'Mudo', 'Aumentar o volume', 'Para cima', 'Desligar a TV']) {
        await expect(button(page, name)).toBeDisabled();
      }
      await expect(button(page, 'Atalho 1')).toHaveAttribute('aria-disabled', 'true');
      await expect(button(page, 'Teclado')).toHaveClass(/\boff\b/);
      // O menu não manda nada à TV: segue disponível.
      await expect(menuButton(page)).toBeEnabled();

      await expectNoVerticalScroll(page);
      await expectNoHorizontalScroll(page);
      await settle(page);
      await shoot(page, `agente-fora-${screen.name}`, info.project.name);
      await expectSound(page);
    });

    test('com as pílulas em fileira e o aviso à vista a tela ainda cabe', async ({ page }) => {
      await signIn(page);
      await page.evaluate(() =>
        localStorage.setItem(
          `uniover.tv.prefs.v2.${localStorage.getItem('uniover.account-id') ?? ''}`,
          JSON.stringify({ pillLayout: 'row' }),
        ),
      );
      await page.goto('/tv');
      await showTv(page);
      await emitSse(page, 'tv.state', {
        ...HOT_STATE,
        agentOnline: false,
        connection: 'disconnected',
        volume: null,
      });
      await expect(page.locator('.reason-row')).toBeVisible();
      await expectNoHorizontalScroll(page);
      // Neste arranjo a tela pode rolar na vertical (o controle prefere rolar a espremer os botões), mas nunca na horizontal.
      expect((await box(page.locator('div.ring'))).height).toBeGreaterThanOrEqual(150);
    });
  });
}

test.describe('menu dos três pontos', () => {
  test('abre com os três pontos à direita e traz apps, personalizar e, para o dono, trocar a TV', async ({
    page,
  }, info) => {
    await openTv(page);
    const dots = menuButton(page);
    const head = await box(header(page));
    const size = await box(dots);
    expect(size.width).toBeCloseTo(44, 0);
    expect(size.height).toBeCloseTo(44, 0);
    expect(Math.abs(size.x + size.width - (head.x + head.width)), 'na ponta direita').toBeLessThan(
      1.5,
    );

    await dots.click();
    const menu = menuDialog(page);
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('heading', { level: 2, name: 'Mais opções' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Apps da TV', exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Personalizar', exact: true })).toBeVisible();
    const bind = menu.getByRole('link', { name: /Gerenciar TVs/ });
    await expect(bind).toHaveAttribute('href', '/ajustes/sistema');
    await expect(bind.getByText('Afeta todos')).toBeVisible();
    await settle(page);
    await expectNoVerticalScroll(page);

    await shoot(page, 'menu-aberto', info.project.name);
    await expectSound(page);
  });

  test('fecha por Esc, pelo toque fora do cartão e pelo gesto, e devolve o foco aos três pontos', async ({
    page,
  }) => {
    await openTv(page);
    const dots = menuButton(page);

    await dots.focus();
    await page.keyboard.press('Enter');
    await expect(menuDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menuDialog(page)).toHaveCount(0);
    await expect(dots).toBeFocused();

    // Toque fora do cartão (o fundo escurecido).
    await dots.click();
    await expect(menuDialog(page)).toBeVisible();
    await settle(page);
    await page.mouse.click(5, 5);
    await expect(menuDialog(page)).toHaveCount(0);
    await expect(dots).toBeFocused();

    // Arrastar o puxador para baixo.
    await dots.click();
    await expect(menuDialog(page)).toBeVisible();
    await settle(page);
    const grab = await box(menuDialog(page).locator('.grab'));
    const x = grab.x + grab.width / 2;
    const y = grab.y + 12;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 140, { steps: 8 });
    await page.mouse.up();
    await expect(menuDialog(page)).toHaveCount(0);
    await expect(dots).toBeFocused();
  });

  test('a saída termina sozinha e, pedindo menos movimento, o cartão não tem transição nenhuma', async ({
    page,
  }) => {
    await openTv(page);
    // Com movimento: a folha sai deslizando e esmaecendo, e só então sai da tela (o fim da saída é o que se espera).
    await menuButton(page).click();
    await expect(menuDialog(page).locator('.card')).toBeVisible();
    await settle(page);
    await page.keyboard.press('Escape');
    await expect(menuDialog(page)).toHaveCount(0);

    // Menos movimento: nenhuma transição no cartão nem no fundo.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await menuButton(page).click();
    await expect(menuDialog(page)).toBeVisible();
    const durations = await menuDialog(page)
      .locator('.card')
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(durations.split(',').every((value) => parseFloat(value) === 0)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(menuDialog(page)).toHaveCount(0);
  });

  test('a linha Apps fecha o menu e abre o painel dos apps, um modal por vez', async ({ page }) => {
    await openTv(page);
    await menuButton(page).click();
    await menuDialog(page).getByRole('button', { name: 'Apps da TV', exact: true }).click();
    await expect(appsDialog(page)).toBeVisible();
    await expect(menuDialog(page)).toHaveCount(0);
    expect(await page.locator('dialog[open]').count()).toBe(1);
    await page.keyboard.press('Escape');
    await expect(appsDialog(page)).toHaveCount(0);
    await expect(menuButton(page)).toBeFocused();
  });

  test('a linha Personalizar fecha o menu e abre a folha, que devolve o foco aos três pontos', async ({
    page,
  }) => {
    await openTv(page);
    await menuButton(page).click();
    await menuDialog(page).getByRole('button', { name: 'Personalizar', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Personalizar' });
    await expect(sheet).toBeVisible();
    await expect(menuDialog(page)).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Concluir' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(menuButton(page)).toBeFocused();
  });

  test('a escolha de Personalizar é da conta: outra pessoa neste aparelho abre com os padrões e o dono a encontra de volta', async ({
    page,
  }) => {
    const guestEmail = GUEST.email;
    identity.guests.push({
      id: '00000000-0000-4000-8000-000000000071',
      displayName: GUEST.displayName,
      email: guestEmail,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:tv', 'tv:control', 'tv:launch', 'tv:edit-shortcuts'],
    });
    tv.shortcuts = [];
    const confortavel = (page: Page) =>
      page
        .getByRole('dialog', { name: 'Personalizar' })
        .getByRole('button', { name: 'Confortável', exact: true });

    // O dono muda o nome, o tamanho e remove uma sugestão.
    await openTv(page);
    await menuButton(page).click();
    await menuDialog(page).getByRole('button', { name: 'Personalizar', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Personalizar' });
    await sheet.getByLabel('Nome da TV').fill('Sala');
    await sheet.getByRole('button', { name: 'Grande', exact: true }).click();
    await sheet.getByRole('button', { name: 'Concluir' }).click();
    await button(page, 'Sugestão: Netflix').click();
    await page
      .getByRole('dialog', { name: 'Netflix' })
      .getByRole('button', { name: 'Remover sugestão' })
      .click();
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('Sala');
    await expect(button(page, 'Sugestão: Netflix')).toHaveCount(0);

    // Sai e entra outra conta no mesmo aparelho: tudo nos padrões.
    await page.goto('/ajustes/perfil');
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/entrar$/);
    await page.getByLabel('E-mail').fill(guestEmail);
    await page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await page.goto('/tv');
    await showTv(page);
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('TV');
    await expect(button(page, 'Sugestão: Netflix')).toBeVisible();
    await menuButton(page).click();
    await menuDialog(page).getByRole('button', { name: 'Personalizar', exact: true }).click();
    await expect(confortavel(page)).toHaveAttribute('aria-pressed', 'true');
    await page
      .getByRole('dialog', { name: 'Personalizar' })
      .getByRole('button', { name: 'Concluir' })
      .click();

    // Volta o dono: a escolha dele estava guardada.
    await page.goto('/ajustes/perfil');
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/entrar$/);
    await page.getByLabel('E-mail').fill(OWNER.email);
    await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await page.goto('/tv');
    await showTv(page, 'Sala');
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('Sala');
    await expect(button(page, 'Sugestão: Netflix')).toHaveCount(0);
    await expect(button(page, 'Sugestão: YouTube')).toBeVisible();
    await menuButton(page).click();
    await menuDialog(page).getByRole('button', { name: 'Personalizar', exact: true }).click();
    await expect(
      page
        .getByRole('dialog', { name: 'Personalizar' })
        .getByRole('button', { name: 'Grande', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('a conta convidada não vê o que afeta todos, e sem nenhuma linha o botão nem existe', async ({
    page,
  }) => {
    signInAsGuest(['module:tv', 'tv:control', 'tv:launch']);
    await page.goto('/tv');
    await showTv(page);
    await menuButton(page).click();
    const menu = menuDialog(page);
    await expect(menu.getByRole('button', { name: 'Apps da TV', exact: true })).toBeVisible();
    await expect(menu.getByRole('link')).toHaveCount(0);
    await expect(menu.getByText('Afeta todos')).toHaveCount(0);
    expect(tv.denied).toEqual([]);
  });
});

test.describe('sem TV configurada', () => {
  test.beforeEach(() => {
    tv.state = { ...HOT_STATE, agentOnline: false, connection: 'disconnected', volume: null };
    tv.wakeFailure = { status: 503, kind: 'agent-not-configured' };
  });

  test('o dono vê um estado vazio com uma ação, Configurar TV, no lugar do controle', async ({
    page,
  }, info) => {
    await signIn(page);
    await page.goto('/tv');
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await emitSse(page, 'tv.state', tv.state);
    await emitSse(page, 'tv.shortcuts', tv.shortcuts);
    const empty = page.locator('.empty');
    await expect(
      empty.getByRole('heading', { level: 2, name: 'Nenhuma TV configurada' }),
    ).toBeVisible();
    const action = empty.getByRole('link', { name: 'Configurar TV' });
    await expect(action).toBeVisible();
    await expect(action).toHaveAttribute('href', '/ajustes/sistema');
    await expect(empty.getByRole('button')).toHaveCount(0);

    // Nenhum botão de comando: o controle inteiro deu lugar ao estado vazio.
    for (const name of ['OK', 'Mudo', 'Teclado', 'Aumentar o volume']) {
      await expect(button(page, name)).toHaveCount(0);
    }
    await expect(page.locator('.shortcuts')).toHaveCount(0);
    // O título cabe numa linha só.
    const title = empty.getByRole('heading', { level: 2 });
    const lineHeight = await title.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect((await box(title)).height).toBeLessThanOrEqual(lineHeight * 1.5);

    await expectNoVerticalScroll(page);
    await expectNoHorizontalScroll(page);
    await shoot(page, 'sem-tv', info.project.name);
    await expectSound(page);
    await action.click();
    await expect(page).toHaveURL(/\/ajustes\/sistema$/);
  });

  test('quem não administra lê uma frase e não recebe botão nenhum', async ({ page }, info) => {
    signInAsGuest(['module:tv', 'tv:control', 'tv:power']);
    await page.goto('/tv');
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await emitSse(page, 'tv.state', tv.state);
    await emitSse(page, 'tv.shortcuts', tv.shortcuts);
    const empty = page.locator('.empty');
    await expect(
      empty.getByRole('heading', { level: 2, name: 'Nenhuma TV configurada' }),
    ).toBeVisible();
    await expect(
      empty.getByText('Peça a quem administra o app para configurar a TV.'),
    ).toBeVisible();
    await expect(empty.getByRole('link')).toHaveCount(0);
    await expect(empty.getByRole('button')).toHaveCount(0);
    await shoot(page, 'sem-tv-convidada', info.project.name);
    expect(tv.denied).toEqual([]);
  });
});

test.describe('sem rede', () => {
  test('o controle fica apagado com o motivo, sem ação (volta sozinho) e com o menu disponível', async ({
    page,
    context,
  }, info) => {
    await openTv(page);
    await context.setOffline(true);
    const row = page.locator('.reason-row');
    await expect(row.getByText(/Sem rede: o controle precisa de internet/)).toBeVisible();
    await expect(row.getByRole('button')).toHaveCount(0);
    for (const name of ['OK', 'Mudo', 'Desligar a TV']) {
      await expect(button(page, name)).toBeDisabled();
    }
    await expect(button(page, 'Teclado')).toHaveClass(/\boff\b/);
    await expect(menuButton(page)).toBeEnabled();
    await shoot(page, 'sem-rede', info.project.name);
    await context.setOffline(false);
    await expect(row).toHaveCount(0);
    await expect(button(page, 'OK')).toBeEnabled();
  });
});

test.describe('sugestões de atalho numa TV sem atalho escolhido', () => {
  test('cabem pela largura, não presumem o app instalado e o toque só abre o painel da sugestão', async ({
    page,
  }, info) => {
    tv.shortcuts = [];
    await openTv(page);
    const tiles = page.locator('.shortcuts .shortcut.suggestion');
    await expect(tiles.first()).toBeVisible();
    const strip = await box(page.locator('app-tv-shortcut-row .top'));
    await expect(tiles).toHaveCount(Math.min(6, Math.floor((strip.width - 8) / 68)));
    await expect(button(page, 'Sugestão: YouTube')).toBeVisible();
    await expectNoVerticalScroll(page);
    await shoot(page, 'sugestoes', info.project.name);

    await button(page, 'Sugestão: Netflix').click();
    const panel = page.getByRole('dialog', { name: 'Netflix' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Sugestão', { exact: true })).toBeVisible();
    // A TV ainda não listou o app: nada a fixar, só o caminho para atualizar a lista e remover.
    await expect(panel.getByText('A lista da TV ainda não traz este app.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Fixar no controle' })).toHaveCount(0);
    await settle(page);
    await shoot(page, 'sugestao-aberta', info.project.name);
    expect(tv.requests.filter((r) => r.method === 'PATCH')).toEqual([]);
  });

  test('confirmar fixa o atalho que a TV já listou, com o ícone dela', async ({ page }) => {
    tv.shortcuts = [
      pending(1, 'Netflix', 'com.netflix.ninja'),
      pending(2, 'Spotify', 'com.spotify.tv.android'),
    ];
    await openTv(page);
    await button(page, 'Sugestão: Netflix').click();
    const panel = page.getByRole('dialog', { name: 'Netflix' });
    await panel.getByRole('button', { name: 'Fixar no controle' }).click();
    await expect(panel).toHaveCount(0);
    await expect.poll(() => tv.requests.filter((r) => r.method === 'PATCH').length).toBe(1);
    expect(tv.requests.find((r) => r.method === 'PATCH')?.body?.['enabled']).toBe(true);
    // Com um atalho escolhido a faixa mostra os atalhos de verdade, e as sugestões saem.
    await expect(page.locator('.shortcuts .shortcut.suggestion')).toHaveCount(0);
    await expect(button(page, 'Netflix')).toBeVisible();
  });

  test('remover some com a sugestão, vale para a conta ao recarregar e o menu a devolve', async ({
    page,
  }) => {
    tv.shortcuts = [];
    await openTv(page);
    await button(page, 'Sugestão: Netflix').click();
    await page
      .getByRole('dialog', { name: 'Netflix' })
      .getByRole('button', { name: 'Remover sugestão' })
      .click();
    await expect(button(page, 'Sugestão: Netflix')).toHaveCount(0);

    await page.reload();
    await showTv(page);
    await expect(button(page, 'Sugestão: YouTube')).toBeVisible();
    await expect(button(page, 'Sugestão: Netflix')).toHaveCount(0);

    await menuButton(page).click();
    await menuDialog(page).getByRole('button', { name: 'Mostrar sugestões de atalhos' }).click();
    await page.keyboard.press('Escape');
    await expect(button(page, 'Sugestão: Netflix')).toBeVisible();
  });

  test('quem não edita os atalhos continua com a dica de sempre', async ({ page }) => {
    tv.shortcuts = [];
    signInAsGuest(['module:tv', 'tv:control', 'tv:launch']);
    await page.goto('/tv');
    await showTv(page);
    await expect(page.getByText('Nenhum app fixado no controle.')).toBeVisible();
    await expect(page.locator('.shortcuts .shortcut.suggestion')).toHaveCount(0);
    expect(tv.denied).toEqual([]);
  });
});
