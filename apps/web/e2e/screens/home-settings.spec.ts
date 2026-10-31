import { Page, Route, TestInfo } from '@playwright/test';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { IdentityMock, OWNER, OWNER_ID, mockIdentityApi } from '../auth/identity-mock';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { expectNoA11yViolations, settle, smallTargets } from './screen-helpers';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

const TABLET = { width: 820, height: 1180 };

let mock: IdentityMock;

test.beforeEach(async ({ context, page }) => {
  await stubWebAuthn(page);
  mock = await mockIdentityApi(context);
  mock.loggedIn = true;
  // A Início consulta o estado da casa e abre o fluxo de eventos: sem a TV simulada as telas dependeriam do que a
  // API real responderia (aqui, nada).
  await mockTvApi(context, mock);
  await installFakeEventSource(page);
});

/** Passkeys, um convite pendente e dois convidados (um com acesso revogado): as listas aparecem cheias. */
function seedAccount(): void {
  mock.passkeys.push(
    {
      id: 'p1',
      name: 'Notebook',
      rawId: 'a',
      createdAt: '2026-09-02T12:00:00Z',
      lastUsedAt: '2026-10-18T09:00:00Z',
    },
    {
      id: 'p2',
      name: 'Celular',
      rawId: 'b',
      createdAt: '2026-10-01T12:00:00Z',
      lastUsedAt: null,
    },
  );
  mock.seedInvite('Alice');
  mock.guests.push(
    {
      id: 'g1',
      displayName: 'Bruno',
      email: 'bruno@exemplo.com',
      password: 'x',
      createdAt: '2026-10-10T10:00:00Z',
      disabledAt: null,
    },
    {
      id: 'g2',
      displayName: 'Carla',
      email: 'carla@exemplo.com',
      password: 'x',
      createdAt: '2026-10-05T10:00:00Z',
      disabledAt: '2026-10-12T10:00:00Z',
    },
  );
}

function printPath(info: TestInfo, name: string, scheme: Scheme): string {
  return `test-results/screens/${name}-${info.project.name}-${scheme}.png`;
}

function landscape(info: TestInfo) {
  const { width, height } = info.project.use.viewport!;
  return { width: height, height: width };
}

async function openHome(page: Page, scheme: Scheme) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    OWNER.displayName.split(' ')[0],
  );
  // TV e Treino, que já têm tela, e os seis módulos planejados ("Em breve").
  await expect(page.locator('article.card')).toHaveCount(8);
  await settle(page);
}

/** A lista de Ajustes (as telas de cada assunto abrem por `openScreen`). */
async function openSettings(page: Page, scheme: Scheme) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto('/ajustes');
  await expect(page.getByRole('heading', { level: 2, name: 'Você' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Pessoas/ })).toBeVisible();
  await settle(page);
}

/** Uma tela de Ajustes pelo endereço, esperando o título dela. */
async function openScreen(page: Page, path: string, title: string, scheme: Scheme) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await settle(page);
}

/**
 * O WebKit do Playwright não traz WebAuthn, e sem ele a tela esconde o botão de cadastrar passkey (o Safari de
 * verdade tem). Os testes só precisam ver o botão e o formulário: a senha errada é recusada antes de qualquer
 * chamada ao autenticador.
 */
async function stubWebAuthn(page: Page) {
  await page.addInitScript(() => {
    if (!('PublicKeyCredential' in window)) {
      Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true });
    }
    if (!navigator.credentials) {
      Object.defineProperty(navigator, 'credentials', {
        value: { get: async () => null, create: async () => null },
        configurable: true,
      });
    } else if (!navigator.credentials.get) {
      Object.defineProperty(navigator.credentials, 'get', {
        value: async () => null,
        configurable: true,
      });
    }
  });
}

test.describe('Início', () => {
  for (const scheme of SCHEMES) {
    test(`prints e acessibilidade no tema ${scheme}`, async ({ page }, info) => {
      await openHome(page, scheme);
      await expectNoHorizontalScroll(page);
      await screenshot(page, printPath(info, 'home', scheme), { fullPage: true });
      expect(await smallTargets(page)).toEqual([]);
      await expectNoA11yViolations(page);

      await page.getByRole('button', { name: 'Editar' }).click();
      const sheet = page.getByRole('dialog', { name: 'Personalizar' });
      await expect(sheet).toBeVisible();
      await expect(sheet.locator('.head .done')).toHaveText('Concluir');
      await expect(sheet.locator('.footer')).toHaveCount(0);
      await expect(sheet.locator('.grip')).toHaveCount(8);
      await settle(page);
      // O foco inicial é o título (nenhuma seta ganha anel sem a pessoa ter tocado) e cada nome cabe numa linha, sem corte.
      await expect(sheet.getByRole('heading', { name: 'Personalizar' })).toBeFocused();
      const names = await sheet.locator('.name').evaluateAll((items) =>
        items.map((item) => ({
          text: item.textContent?.trim(),
          oneLine:
            item.getBoundingClientRect().height <
            parseFloat(getComputedStyle(item).lineHeight) * 1.5,
          cut: item.scrollWidth > item.clientWidth,
        })),
      );
      expect(names.filter((name) => !name.oneLine || name.cut)).toEqual([]);
      await screenshot(page, printPath(info, 'home-sheet', scheme));
      expect(await smallTargets(page)).toEqual([]);
      await expectNoA11yViolations(page);
    });

    test(`tablet e celular deitado no tema ${scheme}`, async ({ page }, info) => {
      for (const [name, size] of [
        ['tablet', TABLET],
        ['landscape', landscape(info)],
      ] as const) {
        await page.setViewportSize(size);
        await openHome(page, scheme);
        await expectNoHorizontalScroll(page);
        await screenshot(page, printPath(info, `home-${name}`, scheme), { fullPage: true });
        expect(await smallTargets(page)).toEqual([]);
      }
      await page.getByRole('button', { name: 'Editar' }).click();
      await expect(page.getByRole('dialog', { name: 'Personalizar' })).toBeVisible();
      await settle(page);
      await screenshot(page, printPath(info, 'home-sheet-landscape', scheme));
      await expectNoHorizontalScroll(page);
    });
  }

  test('a saudação muda de cena pela hora do dia', async ({ page }, info) => {
    const scenes: string[] = [];
    for (const [part, time] of [
      ['morning', '2026-10-20T08:30:00'],
      ['afternoon', '2026-10-20T14:10:00'],
      ['evening', '2026-10-20T21:42:00'],
    ] as const) {
      await page.clock.setFixedTime(new Date(time));
      await openHome(page, 'light');
      scenes.push((await page.locator('.hero .scene path').first().getAttribute('d')) ?? '');
      await screenshot(page, `test-results/screens/home-${part}-${info.project.name}-light.png`);
    }
    expect(new Set(scenes).size).toBe(3);
  });

  test('centraliza a marca e nem consulta os avisos dos computadores', async ({ page }) => {
    const alertRequests: string[] = [];
    await page.route('**/api/v1/devices/agent-alerts', (route) => {
      alertRequests.push(route.request().url());
      return route.fulfill({ contentType: 'application/json', body: '[]' });
    });
    await openHome(page, 'light');
    expect(alertRequests).toEqual([]);

    const center = await page.locator('.home-topbar .brand').evaluate((brand) => {
      const box = brand.getBoundingClientRect();
      return { brand: box.left + box.width / 2, viewport: window.innerWidth };
    });
    expect(center.brand).toBeCloseTo(center.viewport / 2, 0);
    await expect(page.locator('.agent-status')).toHaveAttribute('aria-label', 'Agente ligado');
    await expect(page.locator('.agent-alert')).toHaveCount(0);
  });

  test('estado vazio da Início com todos os módulos ocultos', async ({ page }, info) => {
    await page.addInitScript(
      (account) =>
        localStorage.setItem(
          // A escolha da Início é guardada por conta: esta é a da conta da sessão simulada.
          `uniover.home.widgets.v1.${account}`,
          // Todos os módulos do catálogo desligados (os planejados entram ligados se não estiverem na lista).
          JSON.stringify(
            ['tv', 'training', 'health', 'monitor', 'network', 'backup', 'notifications', 'pc'].map(
              (id) => ({ id, size: 'small', enabled: false }),
            ),
          ),
        ),
      OWNER_ID,
    );
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/');
      await expect(page.getByText('Nenhum módulo na Início')).toBeVisible();
      await settle(page);
      await screenshot(page, printPath(info, 'home-empty', scheme));
      await expectNoA11yViolations(page);
    }
    await page.getByRole('button', { name: 'Escolher módulos' }).click();
    await expect(page.getByRole('dialog', { name: 'Personalizar' })).toBeVisible();
  });

  test('com movimento reduzido nada anima e o foco por teclado é visível', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openHome(page, 'light');
    const animations = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.widget, .hero')).map(
        (el) => getComputedStyle(el).animationName,
      ),
    );
    expect(animations.every((name) => name === 'none')).toBe(true);

    const edit = page.getByRole('button', { name: 'Editar' });
    await edit.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(edit).toBeFocused();
    const outline = await edit.evaluate((el) => {
      const style = getComputedStyle(el);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(2);
  });
});

test.describe('Configurações', () => {
  for (const scheme of SCHEMES) {
    test(`a lista: prints e acessibilidade no tema ${scheme}`, async ({ page }, info) => {
      seedAccount();
      await openSettings(page, scheme);
      await expectNoHorizontalScroll(page);
      await screenshot(page, printPath(info, 'settings', scheme), { fullPage: true });
      expect(await smallTargets(page)).toEqual([]);
      await expectNoA11yViolations(page);
    });

    test(`a lista: tablet e celular deitado no tema ${scheme}`, async ({ page }, info) => {
      seedAccount();
      for (const [name, size] of [
        ['tablet', TABLET],
        ['landscape', landscape(info)],
      ] as const) {
        await page.setViewportSize(size);
        await openSettings(page, scheme);
        await expectNoHorizontalScroll(page);
        await screenshot(page, printPath(info, `settings-${name}`, scheme), { fullPage: true });
        expect(await smallTargets(page)).toEqual([]);
      }
    });

    test(`Segurança: confirmação e formulário de passkey no tema ${scheme}`, async ({
      page,
    }, info) => {
      seedAccount();
      await openScreen(page, '/ajustes/seguranca', 'Segurança', scheme);
      await expect(page.getByText('Notebook', { exact: true })).toBeVisible();

      // Confirmação de remover passkey.
      await page.getByRole('button', { name: 'Remover Notebook' }).click();
      await expect(page.getByText('Remover a passkey Notebook?')).toBeVisible();
      await settle(page);
      await page
        .getByRole('group', { name: 'Remover a passkey Notebook?' })
        .scrollIntoViewIfNeeded();
      await screenshot(page, printPath(info, 'settings-confirm-passkey', scheme));
      await expectNoA11yViolations(page);
      await page.getByRole('button', { name: 'Cancelar' }).click();

      // Formulário de passkey com a senha errada: aviso de erro.
      await page.getByRole('button', { name: 'Cadastrar passkey' }).click();
      await page.getByLabel('Senha', { exact: true }).fill('errada');
      await page.getByRole('button', { name: 'Cadastrar', exact: true }).click();
      await expect(page.getByText('Senha incorreta.')).toBeVisible();
      await page.getByLabel('Senha', { exact: true }).scrollIntoViewIfNeeded();
      await screenshot(page, printPath(info, 'settings-passkey-form', scheme));
      expect(await smallTargets(page)).toEqual([]);
      await expectNoA11yViolations(page);
    });

    test(`Pessoas: revogar acesso e link de convite no tema ${scheme}`, async ({ page }, info) => {
      seedAccount();
      await openScreen(page, '/ajustes/pessoas', 'Pessoas', scheme);
      await expect(page.getByText('Bruno', { exact: true })).toBeVisible();

      // Confirmação de revogar acesso.
      await page.getByRole('button', { name: 'Revogar acesso de Bruno' }).click();
      await expect(page.getByText('poucos minutos')).toBeVisible();
      await page.getByRole('group', { name: /Revogar o acesso de Bruno/ }).scrollIntoViewIfNeeded();
      await screenshot(page, printPath(info, 'settings-confirm-guest', scheme));
      await expectNoA11yViolations(page);
      await page.getByRole('button', { name: 'Cancelar' }).click();

      // Link de convite gerado (com a confirmação já válida).
      mock.stepUpValid = true;
      await page.getByRole('tab', { name: 'Convites' }).click();
      await page.getByRole('button', { name: 'Convidar alguém' }).click();
      await page.getByLabel('Nome do convidado').fill('Diego');
      await page.getByRole('button', { name: 'Gerar convite' }).click();
      await expect(page.getByLabel('Link do convite')).toBeVisible();
      await page.getByLabel('Link do convite').scrollIntoViewIfNeeded();
      await screenshot(page, printPath(info, 'settings-invite-link', scheme));
      expect(await smallTargets(page)).toEqual([]);
      await expectNoA11yViolations(page);
    });
  }

  // Cada lista tem a sua tela: vazia, carregando e com erro.
  for (const screen of [
    {
      path: '/ajustes/seguranca',
      title: 'Segurança',
      route: '**/api/v1/identity/passkeys',
      empty: 'Nenhuma passkey cadastrada.',
      error: 'Não foi possível carregar as passkeys agora.',
    },
    {
      path: '/ajustes/pessoas',
      title: 'Pessoas',
      route: '**/api/v1/identity/guests',
      empty: 'Ninguém foi convidado ainda.',
      error: 'Não foi possível carregar os convidados agora.',
    },
  ]) {
    test(`${screen.title}: carregando, vazio e erro da lista`, async ({ page }, info) => {
      // Um só tratador: segura a resposta enquanto `gate` não abre e, com `failing`, responde 500.
      // Assim nenhuma requisição fica pendurada quando a página recarrega.
      let gate: Promise<void> = Promise.resolve();
      let failing = false;
      await page.route(screen.route, async (route: Route) => {
        await gate;
        if (failing) return route.fulfill({ status: 500 });
        return route.fallback();
      });
      const name = screen.path.split('/').pop()!;

      // Sem dados: lista vazia e a dica.
      await openScreen(page, screen.path, screen.title, 'light');
      await expect(page.getByText(screen.empty)).toBeVisible();
      await screenshot(page, printPath(info, `settings-${name}-empty`, 'light'), {
        fullPage: true,
      });
      await expectNoA11yViolations(page);

      // Carregando: a resposta demora até o teste soltar.
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      await page.reload();
      // O esqueleto da forma da lista (com a espera anunciada): sem o texto solto de antes, nunca uma área vazia.
      await expect(
        page.locator('app-loading-skeleton app-loading-frame[aria-busy="true"]').first(),
      ).toBeVisible();
      await settle(page);
      await screenshot(page, printPath(info, `settings-${name}-loading`, 'light'), {
        fullPage: true,
      });
      await expectNoA11yViolations(page);
      release();
      await expect(page.getByText(screen.empty)).toBeVisible();

      // Erro: o servidor responde 500.
      failing = true;
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.reload();
      await expect(page.getByText(screen.error)).toBeVisible();
      await settle(page);
      await screenshot(page, printPath(info, `settings-${name}-error`, 'dark'), {
        fullPage: true,
      });
      await expectNoA11yViolations(page);
    });
  }

  test('sessão a confirmar (sem conexão com o servidor) aparece em tom de atenção no Perfil', async ({
    page,
  }, info) => {
    mock.offline = true;
    await page.goto('/ajustes/perfil');
    await expect(page.locator('.session')).toContainText('Sessão a confirmar');
    await settle(page);
    await screenshot(page, printPath(info, 'settings-pending', 'light'), { fullPage: true });
    await expectNoA11yViolations(page);
  });

  test('o tema escolhido nos cartões vale na hora e o foco por teclado é visível', async ({
    page,
    browserName,
  }) => {
    seedAccount();
    await openScreen(page, '/ajustes/aparencia', 'Aparência', 'light');
    await page.getByRole('radio', { name: 'Escuro' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('label.theme', { hasText: 'Escuro' })).toHaveCSS(
      'border-top-color',
      /.+/,
    );
    await page.getByRole('radio', { name: /Automático/ }).check();

    // O cartão de tema mostra o foco quando o teclado chega nele. Entra pelo teclado (Tab e Shift+Tab): o WebKit
    // não conta como foco de teclado o que um script focou antes da primeira tecla.
    await page.getByRole('radio', { name: /Automático/ }).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    const focusedCard = page.locator('label.theme:has(input:focus)');
    await expect(focusedCard).toHaveCount(1);
    expect(await focusedCard.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
    // Trocar de cartão pelas setas: o WebKit não marca esse foco como de teclado (o cartão escolhido continua
    // com a borda e o anel de seleção), então só o Chromium confere o contorno.
    await page.keyboard.press('ArrowRight');
    await expect(focusedCard).toHaveCount(1);
    if (browserName === 'chromium') {
      await expect(focusedCard.first()).toBeVisible();
      expect(await focusedCard.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe(
        'none',
      );
    }
  });

  test('o seletor de tema da lista troca na hora, vale também na Aparência e não deixa subtítulos nas linhas', async ({
    page,
  }) => {
    await openSettings(page, 'light');
    await expect(page.locator('a.ui-row .ui-row-sub')).toHaveCount(0);
    const group = page.getByRole('group', { name: 'Tema' });
    await expect(group.getByRole('radio')).toHaveCount(3);
    await group.getByRole('radio', { name: 'Escuro' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await group.getByRole('radio', { name: 'Claro' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await group.getByRole('radio', { name: 'Escuro' }).check();
    // A mesma escolha aparece marcada na tela de Aparência.
    await page.getByRole('link', { name: 'Aparência' }).click();
    await expect(page.getByRole('radio', { name: 'Escuro' })).toBeChecked();
  });

  test('o botão Sair do Perfil mostra o foco por teclado', async ({ page }) => {
    await openScreen(page, '/ajustes/perfil', 'Perfil', 'light');
    const logout = page.getByRole('button', { name: 'Sair' });
    await logout.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(logout).toBeFocused();
    const outline = await logout.evaluate((el) => {
      const style = getComputedStyle(el);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(2);
  });
});
