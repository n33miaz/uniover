import { join } from 'node:path';
import { Page, TestInfo } from '@playwright/test';
import { IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { settle } from '../screens/screen-helpers';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { ShoppingMock, mockShoppingApi } from './shopping-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints (quem roda o teste aponta uma pasta); sem a variável, ficam em `test-results`. */
const SHOTS = process.env['SHOPPING_SHOTS'] ?? 'test-results';

let identity: IdentityMock;
let shopping: ShoppingMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  shopping = await mockShoppingApi(context, identity);
  await mockTvApi(context, identity);
  await installFakeEventSource(page);
});

/** Um print só no iPhone 12 (o alvo do dono), tema claro. */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  if (testInfo.project.name !== 'iphone-12') return;
  await settle(page);
  await screenshot(page, join(SHOTS, `compras-${name}-iphone-12.png`));
}

const listField = (page: Page) => page.getByRole('textbox', { name: 'Adicionar à lista' });
const entryField = (page: Page) => page.getByRole('textbox', { name: 'Item e preço' });
const line = (page: Page, name: string) =>
  page.locator('li.row', {
    has: page.locator('.ui-row-title', { hasText: new RegExp(`^${name}$`) }),
  });
const pick = (page: Page, name: string) => line(page, name).locator('button.pick');

/** O botão de uma linha: o nome dele é a ação seguida de quem ela atinge (este trecho só o leitor de tela ouve). */
const rowButton = (page: Page, action: string, target: string) =>
  page.getByRole('button', { name: new RegExp(`^${action}\\s*: ${target}$`) });

async function openList(page: Page) {
  await page.goto('/compras/lista');
  await expect(listField(page)).toBeVisible();
  await settle(page);
}

/** Põe na lista o que foi digitado; `shown` é o nome como a lista o mostra ("2 pão francês" vira "Pão francês"). */
async function add(page: Page, typed: string, shown = typed) {
  await listField(page).fill(typed);
  await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
  await expect(page.locator('.ui-row-title', { hasText: shown })).toBeVisible();
}

async function put(page: Page, text: string) {
  await entryField(page).fill(text);
  await entryField(page).press('Enter');
}

/** Tudo o que a tela gravou já chegou ao servidor (o recado de "salvando" sumiu e a fila esvaziou). */
async function synced(page: Page) {
  await expect(page.locator('.sync')).toBeEmpty();
}

test.describe('Compras: a entrada', () => {
  test('três caminhos grandes e Detalhes, um toque cada', async ({ page }, testInfo) => {
    await page.goto('/compras');
    const paths = page.locator('a.path');
    await expect(paths).toHaveCount(2);
    await expect(paths.nth(0)).toContainText('Lista');
    await expect(paths.nth(1)).toContainText('Mercado Agora');
    await expect(page.getByRole('link', { name: /Histórico/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Detalhes/ })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, testInfo, 'entrada');

    await paths.nth(0).click();
    await expect(page).toHaveURL(/\/compras\/lista$/);
  });
});

test.describe('Compras: da lista ao mercado', () => {
  test('a lista por corredor, o mercado com o campo único e a compra fechada no histórico', async ({
    page,
  }, testInfo) => {
    await openList(page);
    await add(page, 'Leite');
    await add(page, '2 pão francês', 'Pão francês');
    await add(page, 'Detergente');
    await expect(page.locator('h2.ui-section-label')).toHaveText([
      'Padaria',
      'Laticínios e frios',
      'Limpeza',
    ]);
    await synced(page);
    await expectNoHorizontalScroll(page);
    await shot(page, testInfo, 'lista');

    await page.getByRole('link', { name: 'Ir ao Mercado com a Lista' }).click();
    await page.getByRole('button', { name: /^Usar a Lista/ }).click();
    await synced(page);

    await pick(page, 'Leite').click();
    await expect(pick(page, 'Leite')).toHaveAttribute('aria-pressed', 'true');
    await put(page, 'arroz 2x 12,90');
    await synced(page);
    await expect(page.locator('.total strong')).toContainText('25,80');
    await synced(page);
    const rice = shopping
      .rows('purchaseItem')
      .find(
        (row) =>
          shopping.rows('product').find((p) => p.id === row.payload['productId'])?.payload[
            'name'
          ] === 'Arroz',
      );
    expect(rice?.payload).toMatchObject({ quantity: 2, unitPrice: 12.9, picked: true });

    // O preço pela folha, com a promoção "leve 3 pague 2".
    await line(page, 'Detergente').locator('button.price').click();
    const sheet = page.locator('dialog[open]');
    await sheet
      .getByLabel('Preço da etiqueta')
      .or(sheet.locator('#shopping-sheet-price'))
      .fill('3,00');
    await sheet.getByRole('button', { name: 'Leve 3 pague 2' }).click();
    await expect(sheet).toContainText('Sai R$ 2,00 cada');
    await sheet.getByRole('button', { name: 'Guardar' }).click();
    await expect(line(page, 'Detergente').locator('button.price')).toContainText('2,00');

    await page.getByRole('button', { name: 'Terminei' }).click();
    await page.getByLabel('Loja').fill('Mercado da esquina');
    await page.getByRole('button', { name: 'Fechar a Compra' }).click();
    await expect(page).toHaveURL(/\/compras\/historico$/);
    const trip = page.locator('button.trip', { hasText: 'Mercado da esquina' });
    await expect(trip).toContainText('25,80');
    await trip.click();
    await expect(page.locator('.lines')).toContainText('Arroz');
    await expectNoHorizontalScroll(page);
    await shot(page, testInfo, 'historico');
  });

  test('começar do zero deixa a lista de fora', async ({ page }) => {
    await openList(page);
    await add(page, 'Leite');
    await synced(page);
    await page.goto('/compras/mercado');
    await page.getByRole('button', { name: /^Começar do Zero/ }).click();
    await expect(page.getByText('Digite embaixo o que pegar')).toBeVisible();
    await put(page, 'café 15,90');
    await expect(page.locator('li.row')).toHaveCount(1);
    await synced(page);
    expect(shopping.rows('purchase')[0].payload['fromList']).toBe(false);
  });

  test('sem sinal dá para abrir a compra e marcar; quando o sinal volta, tudo vai para uma compra só', async ({
    context,
    page,
  }) => {
    await openList(page);
    await add(page, 'Leite');
    await add(page, 'Pão');
    await synced(page);

    // Com o service worker bloqueado no teste, a tela do mercado é carregada antes de o sinal cair (no app de verdade
    // ela já está no aparelho).
    await page.getByRole('link', { name: 'Ir ao Mercado com a Lista' }).click();
    await expect(page.getByRole('button', { name: /^Usar a Lista/ })).toBeVisible();
    await context.setOffline(true);
    identity.offline = true;
    await page.getByRole('button', { name: /^Usar a Lista/ }).click();
    await expect(page.getByText('Sem sinal')).toBeVisible();
    await expect(page.getByText('Guardado no aparelho. Vai quando o sinal voltar.')).toBeVisible();
    await pick(page, 'Leite').click();
    await expect(pick(page, 'Leite')).toHaveAttribute('aria-pressed', 'true');
    expect(shopping.rows('purchase')).toHaveLength(0);

    identity.offline = false;
    await context.setOffline(false);
    await synced(page);

    await expect(page.getByText('Guardado no aparelho')).toHaveCount(0);
    await expect(pick(page, 'Leite')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('li.row')).toHaveCount(2);
    expect(shopping.rows('purchase')).toHaveLength(1);
    expect(
      shopping
        .rows('purchaseItem')
        .map((row) => row.payload['picked'])
        .sort(),
    ).toEqual([false, true]);
  });

  test('o que o servidor recusa é desfeito na tela e a pessoa é avisada', async ({ page }) => {
    await openList(page);
    await add(page, 'Leite');
    await synced(page);

    shopping.refuseKind = 'listItem';
    await rowButton(page, 'Já Tenho', 'Leite').click();

    const notice = page.getByRole('alert');
    await expect(notice).toContainText(
      'Uma mudança não foi aceita e foi desfeita. Confira a lista.',
    );
    await expect(page.locator('.ui-row-title')).toHaveText(['Leite']);
    await notice.getByRole('button', { name: 'Entendi' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('Compras: Detalhes', () => {
  test('quem criou o grupo adiciona e tira pessoas e gera o convite com QR', async ({
    page,
  }, testInfo) => {
    await page.goto('/compras/detalhes');
    const members = page.locator('.members').locator('.ui-row-title');
    await expect(members).toHaveText(['Neemias', 'Raphael']);
    await rowButton(page, 'Adicionar', 'Carla').click();
    await expect(members).toHaveText(['Neemias', 'Raphael', 'Carla']);
    await rowButton(page, 'Tirar', 'Raphael').click();
    await expect(members).toHaveText(['Neemias', 'Carla']);
    expect(shopping.memberCalls).toEqual(['add:u-carla', 'remove:u-raphael']);

    await page.getByRole('button', { name: 'Gerar Convite' }).click();
    await expect(page.getByRole('img', { name: 'QR do convite para as Compras' })).toBeVisible();
    await page.locator('.invite').scrollIntoViewIfNeeded();
    expect(shopping.invites).toHaveLength(1);
    await expectNoHorizontalScroll(page);
    await shot(page, testInfo, 'detalhes');

    await page.getByRole('button', { name: 'Cancelar Convite' }).click();
    await expect(page.getByRole('button', { name: 'Gerar Convite' })).toBeVisible();
    expect(shopping.invites[0].revoked).toBe(true);
  });

  test('o link do convite leva para dentro das Compras', async ({ page }) => {
    shopping.invites.push({
      id: 'inv-9',
      token: 'convite-valido-000000000000000000',
      revoked: false,
    });
    await page.goto('/compras/convite#convite-valido-000000000000000000');
    await expect(page).toHaveURL(/\/compras$/);
  });

  test('quem abre o link sem ter entrado passa pelo login e entra no grupo com o mesmo convite', async ({
    page,
  }) => {
    identity.loggedIn = false;
    const token = 'convite-de-quem-nao-entrou-000000000';
    shopping.invites.push({ id: 'inv-8', token, revoked: false });
    const accepted: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/group/invites/accept')) {
        accepted.push((request.postDataJSON() as { token: string }).token);
      }
    });

    // Todo endereço por que a aba passa: só o link colado leva o segredo.
    const visited: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) visited.push(frame.url());
    });

    await page.goto(`/compras/convite#${token}`);
    await expect(page).toHaveURL(/\/entrar/);
    expect(page.url()).not.toContain(token);
    expect(new URL(page.url()).searchParams.get('next')).toBe('/compras/convite');
    await page.getByLabel('E-mail').fill(OWNER.email);
    await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();

    await expect(page).toHaveURL(/\/compras$/);
    expect(accepted).toEqual([token]);
    expect(page.url()).not.toContain(token);
    // O navegador anuncia o link colado (às vezes duas vezes) antes de a tela o limpar; daí em diante, nenhum o leva.
    const cleaned = visited.findIndex((url) => !url.includes(token));
    expect(cleaned).toBeGreaterThan(0);
    expect(
      visited.slice(0, cleaned).every((url) => url.endsWith(`/compras/convite#${token}`)),
    ).toBe(true);
    expect(visited.slice(cleaned).filter((url) => url.includes(token))).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(token);
    expect(await page.evaluate(() => location.hash)).toBe('');
  });

  test('quem só participa vê as pessoas e pode sair, com um segundo toque', async ({ page }) => {
    shopping.people = [
      { userId: 'u-raphael', name: 'Raphael', isOwner: true, isMember: true },
      { userId: 'u1', name: 'Neemias', isOwner: false, isMember: true },
    ];
    await page.goto('/compras/detalhes');

    await expect(page.locator('.members').locator('.ui-row-title')).toHaveText([
      'Raphael',
      'Neemias',
    ]);
    await expect(page.getByRole('button', { name: /^Tirar/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Gerar Convite' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sair do grupo' }).click();
    expect(shopping.memberCalls).toEqual([]);
    await page.getByRole('button', { name: 'Sair mesmo? Toque de novo' }).click();
    await expect(page.locator('.members').locator('.ui-row-title')).toHaveText(['Neemias']);
    expect(shopping.memberCalls).toEqual(['leave']);
  });
});

/**
 * Teclado virtual simulado: o Playwright não abre teclado, então a página ganha um `visualViewport` falso, cuja altura
 * é a da janela menos o que o teclado cobre (é como o Safari do iPhone informa o teclado: a janela não encolhe).
 */
const KEYBOARD = 300;

test('no mercado, com o teclado aberto, o campo e as sugestões ficam inteiros acima dele', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    let covered = 0;
    const target = new EventTarget();
    Object.defineProperties(target, {
      height: { get: () => window.innerHeight - covered },
      offsetTop: { value: 0 },
    });
    Object.defineProperty(window, 'visualViewport', { value: target, configurable: true });
    (window as unknown as Record<string, unknown>)['__cover'] = (px: number) => {
      covered = px;
      target.dispatchEvent(new Event('resize'));
    };
  });
  shopping.advice = {
    available: true,
    reason: null,
    bestDay: '2026-11-14',
    free: { salaryKnown: true, freeCents: 84250 },
  };
  await openList(page);
  for (const name of ['Leite', 'Pão', 'Banana', 'Feijão', 'Café']) await add(page, name);
  await synced(page);
  await page.goto('/compras/mercado');
  await page.getByRole('button', { name: /^Usar a Lista/ }).click();
  await pick(page, 'Banana').click();
  await put(page, 'arroz 2x 12,90');
  await synced(page);
  await expect(page.locator('.cart li.row')).toHaveCount(2);
  await expect(page.locator('.total strong')).toContainText('25,80');

  await entryField(page).focus();
  await entryField(page).fill('lei');
  await page.evaluate(
    (px) => (window as never as { __cover(px: number): void }).__cover(px),
    KEYBOARD,
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--kb-inset'),
      ),
    )
    .toBe(`${KEYBOARD}px`);

  const viewport = page.viewportSize()!;
  const keyboardTop = viewport.height - KEYBOARD;
  for (const target of [
    page.locator('form.ui-action-bar'),
    entryField(page),
    page.getByRole('button', { name: 'Adicionar', exact: true }),
    page.locator('.chips').getByRole('button', { name: 'Leite', exact: true }),
  ]) {
    const box = (await target.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(keyboardTop + 0.5);
  }
  await expectNoHorizontalScroll(page);
  await shot(page, testInfo, 'mercado');
});

test.describe('Compras: voltar ao app', () => {
  /** O app volta do segundo plano: a página fica oculta e depois à vista de novo, como o navegador faz. */
  const comeBack = (page: Page) =>
    page.evaluate(() => {
      const set = (value: string) => {
        Object.defineProperty(document, 'visibilityState', { value, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      };
      set('hidden');
      set('visible');
    });

  test('a lista segue na tela e o envio que cai na volta é refeito em silêncio, sem pedir para tentar de novo', async ({
    context,
    page,
  }) => {
    await openList(page);
    await add(page, 'Leite');
    await synced(page);

    // Sem sinal, a pessoa põe mais um item e fecha o app; o sinal volta enquanto ele está em segundo plano.
    await context.setOffline(true);
    identity.offline = true;
    await add(page, 'Pão');
    await expect(page.getByText('Sem sinal')).toBeVisible();

    // O primeiro envio depois da volta sai numa conexão que o sistema já derrubou.
    let dropped = 0;
    await page.route('**/api/v1/shopping/operations', (route) => {
      if (route.request().method() === 'POST' && dropped === 0) {
        dropped++;
        return route.abort('internetdisconnected');
      }
      return route.fallback();
    });
    // Guarda se o botão de tentar de novo chegou a aparecer, nem que por um instante.
    await page.evaluate(() => {
      const win = window as unknown as Record<string, unknown>;
      win['sawRetry'] = false;
      new MutationObserver(() => {
        if (document.body.textContent?.includes('Tentar Enviar de Novo')) win['sawRetry'] = true;
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });

    await comeBack(page);
    identity.offline = false;
    await context.setOffline(false);

    await expect.poll(() => dropped).toBe(1);
    await expect(page.locator('.ui-row-title', { hasText: 'Leite' })).toBeVisible();
    await expect(page.locator('.ui-row-title', { hasText: 'Pão' })).toBeVisible();
    await expect(page.locator('.sync')).toBeEmpty({ timeout: 15_000 });
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>)['sawRetry']),
    ).toBe(false);
    expect(shopping.rows('product').map((row) => row.payload['name'])).toContain('Pão');
  });
});
