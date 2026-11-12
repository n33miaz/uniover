import { join } from 'node:path';
import { Page } from '@playwright/test';
import { IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { settle } from '../screens/screen-helpers';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { ShoppingMock, mockShoppingApi } from './shopping-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vai o print (quem roda o teste aponta uma pasta); sem a variável, fica em `test-results`. */
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

const addField = (page: Page) => page.getByRole('textbox', { name: 'Adicionar à lista' });
const marketRow = (page: Page, name: string) => page.locator('.market .ui-row', { hasText: name });
const pick = (page: Page, name: string) =>
  marketRow(page, name).getByRole('button', { name: new RegExp(`^${name}`) });

/** O botão de uma linha: o nome dele é a ação seguida de quem ela atinge (este trecho só o leitor de tela ouve). */
const rowButton = (page: Page, action: string, target: string) =>
  page.getByRole('button', { name: new RegExp(`^${action}\\s*: ${target}$`) });

async function openShopping(page: Page) {
  await page.goto('/compras');
  await expect(addField(page)).toBeVisible();
  await settle(page);
}

async function add(page: Page, name: string) {
  await addField(page).fill(name);
  await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
  await expect(page.locator('.ui-row-title', { hasText: name })).toBeVisible();
}

/** Tudo o que a tela gravou já chegou ao servidor (o recado de "salvando" sumiu e a fila esvaziou). */
async function synced(page: Page) {
  await expect(page.locator('.sync')).toBeEmpty();
}

test.describe('Compras: da lista ao mercado', () => {
  test('o preço não marca o item; marcar é outro toque, e a compra fechada vai para as anteriores', async ({
    page,
  }) => {
    await openShopping(page);
    await add(page, 'Leite');
    await add(page, 'Pão');
    await page.getByRole('button', { name: 'Ir ao mercado' }).click();
    await synced(page);

    const price = page.getByRole('textbox', { name: 'Preço de Leite' });
    await price.fill('4,50');
    await price.blur();
    await expect(pick(page, 'Leite')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.total strong')).toContainText('0,00');

    await pick(page, 'Leite').click();
    await expect(pick(page, 'Leite')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.total strong')).toContainText('4,50');
    await synced(page);
    expect(
      shopping
        .rows('purchaseItem')
        .map((line) => [line.payload['picked'], line.payload['unitPrice']]),
    ).toEqual([
      [true, 4.5],
      [false, null],
    ]);

    await page.getByLabel('Loja').fill('Mercado da esquina');
    await page.getByRole('button', { name: 'Fechar a compra' }).click();
    await expect(page.locator('.ui-row', { hasText: 'Mercado da esquina' })).toContainText('4,50');
    await page.getByRole('button', { name: 'Voltar à lista' }).click();
    // O que foi pego saiu da lista; o que ficou na prateleira continua nela.
    await expect(page.locator('.ui-row-title')).toHaveText(['Pão']);
    await expectNoHorizontalScroll(page);
  });

  test('sem sinal dá para abrir a compra e marcar; quando o sinal volta, tudo vai para uma compra só', async ({
    context,
    page,
  }) => {
    await openShopping(page);
    await add(page, 'Leite');
    await add(page, 'Pão');
    await synced(page);

    await context.setOffline(true);
    identity.offline = true;
    await page.getByRole('button', { name: 'Ir ao mercado' }).click();
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
    await expect(page.locator('.market .ui-row')).toHaveCount(2);
    expect(shopping.rows('purchase')).toHaveLength(1);
    expect(
      shopping
        .rows('purchaseItem')
        .map((line) => line.payload['picked'])
        .sort(),
    ).toEqual([false, true]);
  });

  test('o que o servidor recusa é desfeito na tela e a pessoa é avisada', async ({ page }) => {
    await openShopping(page);
    await add(page, 'Leite');
    await synced(page);

    shopping.refuseKind = 'listItem';
    await rowButton(page, 'Já tenho', 'Leite').click();

    const notice = page.getByRole('alert');
    await expect(notice).toContainText(
      'Uma mudança não foi aceita e foi desfeita. Confira a lista.',
    );
    await expect(page.locator('.ui-row-title')).toHaveText(['Leite']);
    await notice.getByRole('button', { name: 'Entendi' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('Compras: as pessoas do grupo', () => {
  test('quem criou o grupo adiciona e tira pessoas', async ({ page }) => {
    await openShopping(page);
    await page.getByRole('button', { name: 'Pessoas' }).click();

    const members = page.locator('.members').locator('.ui-row-title');
    await expect(members).toHaveText(['Neemias', 'Raphael']);
    await rowButton(page, 'Adicionar', 'Carla').click();
    await expect(members).toHaveText(['Neemias', 'Raphael', 'Carla']);
    await rowButton(page, 'Tirar', 'Raphael').click();
    await expect(members).toHaveText(['Neemias', 'Carla']);
    await expect(page.locator('.candidates').locator('.ui-row-title')).toHaveText(['Raphael']);
    expect(shopping.memberCalls).toEqual(['add:u-carla', 'remove:u-raphael']);
    await expectNoHorizontalScroll(page);
  });

  test('quem só participa vê as pessoas e pode sair, com um segundo toque', async ({ page }) => {
    shopping.people = [
      { userId: 'u-raphael', name: 'Raphael', isOwner: true, isMember: true },
      { userId: 'u1', name: 'Neemias', isOwner: false, isMember: true },
    ];
    await openShopping(page);
    await page.getByRole('button', { name: 'Pessoas' }).click();

    await expect(page.locator('.members').locator('.ui-row-title')).toHaveText([
      'Raphael',
      'Neemias',
    ]);
    await expect(page.getByRole('button', { name: /^Tirar/ })).toHaveCount(0);
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

test('com o teclado aberto, a barra de adicionar fica inteira acima dele', async ({
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
  await openShopping(page);
  for (const name of ['Leite', 'Pão', 'Arroz', 'Feijão', 'Café']) await add(page, name);

  await addField(page).focus();
  await addField(page).fill('Le');
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
    addField(page),
    page.getByRole('button', { name: 'Adicionar', exact: true }),
    page.locator('.suggestions').getByRole('button', { name: 'Leite' }),
  ]) {
    const box = (await target.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(keyboardTop + 0.5);
  }
  if (testInfo.project.name === 'iphone-12') {
    await screenshot(page, join(SHOTS, 'compras-teclado-iphone-12.png'));
  }
});
