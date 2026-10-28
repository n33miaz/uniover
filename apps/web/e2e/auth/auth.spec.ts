import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';
import {
  expect,
  expectNoHorizontalScroll,
  screenshot,
  test,
  waitForServiceWorkerControl,
} from '../fixtures';
import { settle } from '../screens/screen-helpers';
import { expectNoA11yViolations } from './entry-helpers';
import { IdentityMock, OWNER, OWNER_ID, mockIdentityApi } from './identity-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

// A escolha da Início é guardada por conta: esta é a chave da conta da sessão simulada.
const MODULE_PREFS_KEY = `uniover.home.widgets.v1.${OWNER_ID}`;
async function expectNoSeriousA11yViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

async function signIn(page: Page, email = OWNER.email, password = OWNER.password) {
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
}

/** Tudo o que o navegador guarda para a página: nenhuma delas pode conter um JWT. */
async function storageDump(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const parts: string[] = [
      JSON.stringify({ ...localStorage }),
      JSON.stringify({ ...sessionStorage }),
    ];
    const names = (await indexedDB.databases?.())?.map((db) => db.name).filter(Boolean) ?? [];
    for (const name of names as string[]) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((resolve) => {
          const request = db.transaction(store).objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result);
        });
        parts.push(JSON.stringify(rows));
      }
      db.close();
    }
    return parts.join('\n');
  });
}

let mock: IdentityMock;

test.beforeEach(async ({ context }) => {
  mock = await mockIdentityApi(context);
});

test.describe('entrada e sessão', () => {
  test('sem sessão vai para a tela de entrada; entrar leva ao Início e nada de token fica guardado', async ({
    page,
  }, info) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/entrar$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
    // No celular o campo não ganha foco sozinho (o teclado cobriria a tela antes de ela ser lida).
    await expect(page.getByLabel('E-mail')).not.toBeFocused();
    await expectNoHorizontalScroll(page);
    await screenshot(page, `test-results/login-${info.project.name}.png`);

    await signIn(page);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Bom dia|Boa tarde|Boa noite/);

    // Varredura de armazenamento: nenhum JWT em localStorage, sessionStorage nem IndexedDB.
    expect(mock.issuedTokens.length).toBeGreaterThan(0);
    const stored = await storageDump(page);
    expect(stored).not.toMatch(/eyJ/);
    for (const token of mock.issuedTokens) expect(stored).not.toContain(token);
  });

  test('nenhuma URL pedida leva token e todo POST de autenticação leva o cabeçalho do cliente', async ({
    page,
  }) => {
    await page.goto('/entrar');
    await signIn(page);
    await expect(page).toHaveURL(/\/$/);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Bom dia|Boa tarde|Boa noite/);

    for (const request of mock.requests) {
      expect(request.url).not.toMatch(/eyJ/);
      expect(request.url).not.toMatch(/token=/i);
      if (request.method === 'POST' && request.path.startsWith('/auth/')) {
        expect(request.headers['x-uniover-client'], request.path).toBe('web');
      }
      if (request.path === '/auth/login' || request.path === '/auth/refresh') {
        expect(request.headers['authorization'], request.path).toBeUndefined();
      }
    }
    const me = mock.requests.find((r) => r.path === '/me');
    expect(me?.headers['authorization']).toMatch(/^Bearer eyJ/);
  });

  test('a saudação usa o nome da conta e o link Configurações leva à tela de configurações', async ({
    page,
  }) => {
    await page.goto('/entrar');
    await signIn(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      // A saudação traz só o primeiro nome da conta.
      new RegExp('(Bom dia|Boa tarde|Boa noite), ' + OWNER.displayName.split(' ')[0] + '$'),
    );
    await expect(page.locator('app-session-notice .notice')).toHaveCount(0);
    await page.getByRole('link', { name: 'Configurações' }).click();
    await expect(page).toHaveURL(/\/ajustes$/);
  });

  test('recarregar mantém a sessão pelo refresh silencioso e Sair encerra', async ({ page }) => {
    await page.goto('/entrar');
    await signIn(page);
    await expect(page).toHaveURL(/\/$/);

    const before = mock.refreshCalls;
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Bom dia|Boa tarde|Boa noite/);
    await expect(page).toHaveURL(/\/$/);
    expect(mock.refreshCalls).toBe(before + 1);

    await page.goto('/ajustes/perfil');
    await expect(page.getByText('Sessão ativa.')).toBeVisible();
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/entrar$/);
    expect(mock.loggedIn).toBe(false);

    await page.reload();
    await expect(page).toHaveURL(/\/entrar$/);
  });

  test('mensagem genérica para senha errada e contagem regressiva quando a conta bloqueia', async ({
    page,
  }) => {
    await page.goto('/entrar');
    await signIn(page, OWNER.email, 'errada');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('E-mail ou senha incorretos.');
    await expect(alert).toBeFocused();
    await expect(page).toHaveURL(/\/entrar$/);

    await signIn(page, 'bloqueado@exemplo.com', 'qualquer');
    await expect(alert).toContainText('Conta bloqueada');
    // O número que anda não é lido: o que vale aqui é o formato m:ss e o botão trancado até a espera acabar.
    await expect(page.locator('.wait-time')).toHaveText(/^0:0[1-3]$/);
    await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeEnabled({
      timeout: 8_000,
    });
    await expect(page.getByRole('status').filter({ hasText: 'Pronto' })).toBeVisible();
  });

  test('link direto sem sessão volta ao destino depois de entrar', async ({ page }) => {
    await page.goto('/ajustes');
    await expect(page).toHaveURL(/\/entrar\?next=%2Fajustes$/);
    await signIn(page);
    await expect(page).toHaveURL(/\/ajustes$/);
  });

  for (const [label, next] of [
    ['barra dupla', '%2F%2Fevil.example.com'],
    ['URL absoluta', 'https%3A%2F%2Fevil.example.com'],
    ['barra invertida', '%2F%5Cevil.example.com'],
  ]) {
    test(`destino malicioso no retorno é ignorado (${label})`, async ({ page }) => {
      await page.goto(`/entrar?next=${next}`);
      await signIn(page);
      await expect(page).toHaveURL(/localhost:\d+\/$/);
    });
  }

  test('401 do refresh não apaga nada do aparelho', async ({ page }) => {
    await page.goto('/entrar');
    await page.evaluate(
      async ([key]) => {
        localStorage.setItem(key, '[{"id":"tv","size":"wide","enabled":false}]');
        await new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('uniover-fila-teste', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('itens');
          open.onsuccess = () => {
            const tx = open.result.transaction('itens', 'readwrite');
            tx.objectStore('itens').put('comando-pendente', 'a');
            tx.oncomplete = () => {
              open.result.close();
              resolve();
            };
          };
          open.onerror = () => reject(open.error);
        });
      },
      [MODULE_PREFS_KEY],
    );

    await page.reload();
    await expect(page).toHaveURL(/\/entrar$/);
    expect(mock.loggedIn).toBe(false);
    expect(await page.evaluate((key) => localStorage.getItem(key), MODULE_PREFS_KEY)).toContain(
      'wide',
    );
    expect(await storageDump(page)).toContain('comando-pendente');

    // Entrar e sair também não mexem nos dados locais.
    await signIn(page);
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/ajustes/perfil');
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/entrar$/);
    expect(await page.evaluate((key) => localStorage.getItem(key), MODULE_PREFS_KEY)).toContain(
      'wide',
    );
    expect(await storageDump(page)).toContain('comando-pendente');
  });

  test('duas abas recarregando juntas renovam uma por vez e as duas ficam na sessão', async ({
    page,
    context,
  }) => {
    await page.goto('/entrar');
    await signIn(page);
    await expect(page).toHaveURL(/\/$/);

    mock.refreshDelayMs = 400;
    mock.refreshCalls = 0;
    mock.maxRefreshInFlight = 0;
    const second = await context.newPage();
    await Promise.all([page.goto('/'), second.goto('/')]);
    for (const tab of [page, second]) {
      await expect(tab.getByRole('heading', { level: 1 })).toHaveText(
        /Bom dia|Boa tarde|Boa noite/,
        { timeout: 10_000 },
      );
      await expect(tab).toHaveURL(/\/$/);
    }
    // Cada aba tem o token na própria memória, então as duas renovam; o bloqueio só as põe em fila.
    expect(mock.refreshCalls).toBe(2);
    expect(mock.maxRefreshInFlight).toBe(1);
  });

  test('sem rede a sessão fica a confirmar, a casca abre e nada é apagado', async ({ page }) => {
    await page.goto('/entrar');
    await signIn(page);
    await expect(page).toHaveURL(/\/$/);
    await page.evaluate((key) => localStorage.setItem(key, '[]'), MODULE_PREFS_KEY);

    mock.offline = true;
    await page.reload();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Bom dia|Boa tarde|Boa noite/);
    await page.goto('/ajustes/perfil');
    await expect(page).toHaveURL(/\/ajustes\/perfil$/);
    // O aviso global (raiz do app) e o texto do Perfil mostram o mesmo estado.
    await expect(page.locator('app-session-notice .notice')).toBeVisible();
    await expect(page.locator('.session')).toContainText('Sessão a confirmar');
    expect(await page.evaluate((key) => localStorage.getItem(key), MODULE_PREFS_KEY)).toBe('[]');

    // A rede volta: a sessão é confirmada sozinha, sem digitar nada.
    mock.offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText('Sessão ativa.')).toBeVisible();
  });
});

test.describe('ajustes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/entrar');
    await signIn(page);
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/ajustes');
    await expect(page.getByRole('heading', { level: 2, name: 'Você' })).toBeVisible();
  });

  test('é uma lista: cada tela de Configurações tem a sua linha, com resumo e o caminho', async ({
    page,
  }, info) => {
    const rows = page.locator('a.ui-row');
    await expect(rows.locator('.ui-row-title')).toHaveText([
      'Perfil',
      'Aparência',
      'Segurança',
      'Pessoas e Permissões',
      'Dispositivos',
      'Sistema',
      'Auditoria',
      'Sobre',
    ]);
    await expect(rows).toHaveCount(8);
    for (const [name, href] of [
      ['Perfil', '/ajustes/perfil'],
      ['Aparência', '/ajustes/aparencia'],
      ['Segurança', '/ajustes/seguranca'],
      ['Pessoas', '/ajustes/pessoas'],
      ['Dispositivos', '/ajustes/dispositivos'],
      ['Auditoria', '/ajustes/auditoria'],
      ['Sistema', '/ajustes/sistema'],
      ['Sobre', '/ajustes/sobre'],
    ]) {
      await expect(page.getByRole('link', { name: new RegExp('^' + name) })).toHaveAttribute(
        'href',
        href,
      );
    }
    await expect(page.getByText(`${OWNER.displayName} · Administrador`)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await screenshot(page, `test-results/settings-${info.project.name}.png`);
  });

  test('o Perfil mostra a conta e o papel, e a seta volta para a lista', async ({ page }) => {
    await page.getByRole('link', { name: /^Perfil/ }).click();
    await expect(page).toHaveURL(/\/ajustes\/perfil$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Perfil' })).toBeVisible();
    await expect(page.getByText(OWNER.displayName, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(OWNER.email)).toBeVisible();
    await expect(page.getByText('Administrador', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Voltar às Configurações' }).click();
    await expect(page).toHaveURL(/\/ajustes$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Configurações' })).toBeVisible();
  });

  test('a Aparência tem só o tema e o atalho: os módulos ficam em Personalizar', async ({
    page,
  }) => {
    await page.getByRole('link', { name: /^Aparência/ }).click();
    await expect(page).toHaveURL(/\/ajustes\/aparencia$/);
    await expect(page.getByRole('radio', { name: 'Escuro' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Módulos' })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: /TV/ })).toHaveCount(0);
  });

  test('o Sobre mostra as versões e leva aos Créditos', async ({ page }) => {
    await page.getByRole('link', { name: /^Sobre/ }).click();
    await expect(page).toHaveURL(/\/ajustes\/sobre$/);
    await expect(page.getByText('0.5.0-teste')).toBeVisible();
    await expect(page.getByRole('link', { name: /^Créditos/ })).toHaveAttribute(
      'href',
      '/ajustes/creditos',
    );
  });

  test('a Segurança mostra as passkeys', async ({ page }) => {
    await page.getByRole('link', { name: /^Segurança/ }).click();
    await expect(page).toHaveURL(/\/ajustes\/seguranca$/);
    await expect(page.getByText('A passkey só confirma ações perigosas')).toBeVisible();
  });

  test('tema escuro fica salvo no aparelho e volta ao recarregar', async ({ page }) => {
    await page.goto('/ajustes/aparencia');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('radio', { name: 'Escuro' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.getByRole('radio', { name: 'Escuro' })).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('radio', { name: /Automático/ }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('acessibilidade (axe) na lista e em cada tela, nos temas claro e escuro', async ({
    page,
  }) => {
    // Movimento reduzido: as animações de entrada saem do caminho e o axe mede as cores finais.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      for (const path of ['/ajustes', '/ajustes/perfil', '/ajustes/aparencia', '/ajustes/sobre']) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await settle(page);
        await expectNoSeriousA11yViolations(page);
      }
    }
  });
});

test.describe('acessibilidade da tela de entrada', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`axe sem nenhuma violação no tema ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/entrar');
      await expect(page.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
      await expectNoA11yViolations(page);
      // Com o erro na tela também.
      await signIn(page, OWNER.email, 'errada');
      await expect(page.getByRole('alert')).toBeVisible();
      await expectNoA11yViolations(page);
    });
  }
});

test.describe('casca offline com o service worker', () => {
  test.use({ serviceWorkers: 'allow' });

  test('offline a casca abre em Configurações sem mandar para a entrada e mostra a sessão a confirmar', async ({
    page,
    context,
  }) => {
    // Sem API simulada aqui: o que se prova é o comportamento do app com a rede de fato fora.
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await page.goto('/');
    await waitForServiceWorkerControl(page);
    await page.evaluate((key) => localStorage.setItem(key, '[]'), MODULE_PREFS_KEY);

    await context.setOffline(true);
    await page.goto('/ajustes/perfil');
    await expect(page).toHaveURL(/\/ajustes\/perfil$/);
    await expect(page.locator('app-session-notice .notice')).toBeVisible();
    await expect(page.locator('.session')).toContainText('Sessão a confirmar');
    await expect(page.getByRole('heading', { level: 2, name: 'Conta' })).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), MODULE_PREFS_KEY)).toBe('[]');
    await context.setOffline(false);
  });
});
