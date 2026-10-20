import AxeBuilder from '@axe-core/playwright';
import { Page, Route, TestInfo } from '@playwright/test';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';

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
  await expect(page.getByRole('heading', { level: 1 })).toContainText(OWNER.displayName);
  await expect(page.locator('article.card')).toHaveCount(2);
  await settle(page);
}

async function openSettings(page: Page, scheme: Scheme) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto('/ajustes');
  await expect(page.getByRole('heading', { level: 2, name: 'Conta' })).toBeVisible();
  await expect(page.getByText('Notebook', { exact: true })).toBeVisible();
  await expect(page.getByText('Bruno', { exact: true })).toBeVisible();
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

/** Espera as animações de entrada terminarem para o print e o axe verem a tela parada. */
async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished),
    ),
  );
}

/** Falha com qualquer violação do axe (inclusive leve e moderada), não só as graves. */
async function expectNoA11yViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(
    violations.map(
      (v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
    ),
  ).toEqual([]);
}

/** Alvos de toque com menos de 44 px (interruptores e opções ganham a área do rótulo ou da linha). */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const selector = 'a[href], button, input, select, textarea, [role="switch"], [role="radio"]';
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      let box = element.getBoundingClientRect();
      if (
        element instanceof HTMLInputElement &&
        (element.type === 'checkbox' || element.type === 'radio')
      ) {
        const host = element.closest('label, li');
        if (host) box = host.getBoundingClientRect();
      }
      if (box.width === 0 || box.height === 0) continue;
      if (Math.min(box.width, box.height) < 43.5) {
        const label = element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '';
        found.push(
          `${element.tagName.toLowerCase()} "${label.slice(0, 30)}" ${Math.round(box.width)}x${Math.round(box.height)}`,
        );
      }
    }
    return found;
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
      const sheet = page.getByRole('dialog', { name: 'Editar a Início' });
      await expect(sheet).toBeVisible();
      await settle(page);
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
      await expect(page.getByRole('dialog', { name: 'Editar a Início' })).toBeVisible();
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

  test('faixa e cartões com os estados "sem dados", "bom" e "atenção" passam no axe nos dois temas', async ({
    page,
  }) => {
    for (const scheme of SCHEMES) {
      await openHome(page, scheme);
      // O estado real do agente ainda não chega à Início; força as classes de tom para provar o contraste.
      await page.evaluate(() => {
        const chips = document.querySelectorAll('.chips .chip');
        chips[0]?.classList.add('ok');
        chips[1]?.classList.add('warn');
        const badges = document.querySelector('article[data-module="tv"] .badges');
        badges?.insertAdjacentHTML(
          'beforeend',
          '<span class="chip ui-chip ok"><span class="dot ui-dot"></span>Pronto para usar</span>',
        );
        document
          .querySelector('article[data-module="training"] .badges')
          ?.insertAdjacentHTML(
            'beforeend',
            '<span class="chip ui-chip warn"><span class="dot ui-dot"></span>Sem agente em casa</span>',
          );
      });
      await expectNoA11yViolations(page);
    }
  });

  test('estado vazio da Início com todos os módulos ocultos', async ({ page }, info) => {
    await page.addInitScript(() =>
      localStorage.setItem(
        'uniover.home.widgets.v1',
        JSON.stringify([
          { id: 'tv', size: 'small', enabled: false },
          { id: 'training', size: 'wide', enabled: false },
        ]),
      ),
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
    await expect(page.getByRole('dialog', { name: 'Editar a Início' })).toBeVisible();
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

test.describe('Ajustes', () => {
  for (const scheme of SCHEMES) {
    test(`prints e acessibilidade no tema ${scheme}`, async ({ page }, info) => {
      seedAccount();
      await openSettings(page, scheme);
      await expectNoHorizontalScroll(page);
      await screenshot(page, printPath(info, 'settings', scheme), { fullPage: true });
      expect(await smallTargets(page)).toEqual([]);
      await expectNoA11yViolations(page);
    });

    test(`tablet e celular deitado no tema ${scheme}`, async ({ page }, info) => {
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

    test(`confirmações, formulários e avisos no tema ${scheme}`, async ({ page }, info) => {
      seedAccount();
      await openSettings(page, scheme);

      // Confirmação de remover passkey e de revogar acesso, uma de cada vez.
      await page.getByRole('button', { name: 'Remover Notebook' }).click();
      await expect(page.getByText('Remover a passkey Notebook?')).toBeVisible();
      await settle(page);
      await page
        .getByRole('group', { name: 'Remover a passkey Notebook?' })
        .scrollIntoViewIfNeeded();
      await screenshot(page, printPath(info, 'settings-confirm-passkey', scheme));
      await expectNoA11yViolations(page);
      await page.getByRole('button', { name: 'Cancelar' }).click();

      await page.getByRole('button', { name: 'Revogar acesso de Bruno' }).click();
      await expect(page.getByText('poucos minutos')).toBeVisible();
      await page.getByRole('group', { name: /Revogar o acesso de Bruno/ }).scrollIntoViewIfNeeded();
      await screenshot(page, printPath(info, 'settings-confirm-guest', scheme));
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
      await page.getByRole('button', { name: 'Cancelar' }).click();

      // Link de convite gerado (com a confirmação já válida).
      mock.stepUpValid = true;
      await page.getByLabel('Nome do convidado').fill('Diego');
      await page.getByRole('button', { name: 'Gerar convite' }).click();
      await expect(page.getByLabel('Link do convite')).toBeVisible();
      await page.getByLabel('Link do convite').scrollIntoViewIfNeeded();
      await screenshot(page, printPath(info, 'settings-invite-link', scheme));
      expect(await smallTargets(page)).toEqual([]);
      await expectNoA11yViolations(page);
    });
  }

  test('carregando, vazio e erro das listas', async ({ page }, info) => {
    // Um só tratador por lista: segura a resposta enquanto `gate` não abre e, com `failing`, responde 500.
    // Assim nenhuma requisição fica pendurada quando a página recarrega.
    let gate: Promise<void> = Promise.resolve();
    let failing = false;
    const lists = async (route: Route) => {
      await gate;
      if (failing) return route.fulfill({ status: 500 });
      return route.fallback();
    };
    await page.route('**/api/v1/identity/passkeys', lists);
    await page.route('**/api/v1/identity/guests', lists);

    // Sem dados: listas vazias e as dicas.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/ajustes');
    await expect(page.getByText('Nenhuma passkey cadastrada.')).toBeVisible();
    await expect(page.getByText('Nenhum convidado ainda.')).toBeVisible();
    await settle(page);
    await screenshot(page, printPath(info, 'settings-empty', 'light'), { fullPage: true });
    await expectNoA11yViolations(page);

    // Carregando: a resposta das listas demora até o teste soltar.
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    await page.reload();
    await expect(page.getByText('Carregando as passkeys…')).toBeVisible();
    await expect(page.getByText('Carregando os convidados…')).toBeVisible();
    await screenshot(page, printPath(info, 'settings-loading', 'light'), { fullPage: true });
    await expectNoA11yViolations(page);
    release();
    await expect(page.getByText('Nenhuma passkey cadastrada.')).toBeVisible();
    await expect(page.getByText('Nenhum convidado ainda.')).toBeVisible();

    // Erro: o servidor responde 500.
    failing = true;
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(page.getByText('Não foi possível carregar as passkeys agora.')).toBeVisible();
    await expect(page.getByText('Não foi possível carregar os convidados agora.')).toBeVisible();
    await settle(page);
    await screenshot(page, printPath(info, 'settings-error', 'dark'), { fullPage: true });
    await expectNoA11yViolations(page);
  });

  test('sessão a confirmar (sem conexão com o servidor) aparece em tom de atenção', async ({
    page,
  }, info) => {
    mock.offline = true;
    await page.goto('/ajustes');
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
    await openSettings(page, 'light');
    await page.getByRole('radio', { name: 'Escuro' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('label.theme', { hasText: 'Escuro' })).toHaveCSS(
      'border-top-color',
      /.+/,
    );
    await page.getByRole('radio', { name: /Automático/ }).check();

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

    // O cartão de tema mostra o foco quando o teclado chega nele. Entra pelo teclado (Tab e Shift+Tab): o WebKit
    // não conta como foco de teclado o que um script focou antes da primeira tecla.
    await page.getByRole('radio', { name: 'Claro' }).focus();
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
      expect(await focusedCard.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe(
        'none',
      );
    }
  });
});
