import { Page } from '@playwright/test';
import { IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, screenshot, test } from '../fixtures';
import { PcMock, mockPcApi } from '../pc/pc-mock';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { settle } from './screen-helpers';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints antes/depois (quem roda aponta uma pasta e dá um rótulo); sem elas, o teste do print não roda. */
const SHOTS = process.env['HOME_SHOTS'];
const TAG = process.env['HOME_TAG'] ?? 'depois';

let identity: IdentityMock;
let pc: PcMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  pc = await mockPcApi(context, identity);
  await mockTvApi(context, identity);
  await installFakeEventSource(page);
});

/**
 * Grava, desde o primeiro quadro, cada aparência que o cartão do Controle do PC teve na Início. Uma aparência é o que o dono
 * enxergaria: "planned" (cartão tracejado, ícone cinza), "soon" (rótulo "Em Breve"), "link" (cartão que abre) ou "plain".
 */
async function recordPcCard(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __pcCard: string[] }).__pcCard = seen;
    const look = () => {
      const card = document.querySelector('article[data-module="pc"]');
      if (!card) return 'absent';
      const parts = ['card'];
      if (card.classList.contains('planned')) parts.push('planned');
      if (card.querySelector('app-home-soon-badge')) parts.push('soon');
      if (card.querySelector('a.card-link')) parts.push('link');
      if (card.querySelector('app-module-app-icon.planned')) parts.push('icon-planned');
      return parts.join('+');
    };
    const note = () => {
      const now = look();
      if (seen[seen.length - 1] !== now) seen.push(now);
    };
    new MutationObserver(note).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    note();
  });
}

const looks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __pcCard: string[] }).__pcCard);

/** Segura a resposta do estado do PC até `release()` (o servidor acordando); depois deixa a API simulada responder. */
async function holdPcStatus(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let asked = false;
  await page.route('**/api/v1/pc/status', async (route) => {
    asked = true;
    await gate;
    await route.fallback();
  });
  return { release, asked: () => asked };
}

const card = (page: Page) => page.locator('article[data-module="pc"]');

test.describe('Início: o cartão do Controle do PC não pisca', () => {
  test('conta com computador: o cartão nunca aparece como desativado, nem enquanto a resposta não chega', async ({
    page,
  }) => {
    await recordPcCard(page);
    const hold = await holdPcStatus(page);
    await page.goto('/');
    await expect(page.locator('article[data-module="tv"]')).toBeVisible();
    await expect.poll(() => hold.asked()).toBe(true);
    // A resposta ainda não chegou: o que a tela mostra do PC já vale (sem cartão cinza, sem "Em Breve").
    for (const look of await looks(page)) expect(look).not.toMatch(/planned|soon/);

    hold.release();
    await expect(card(page).locator('a.card-link')).toHaveAttribute(
      'aria-label',
      'Controle do PC: Abrir controle',
    );
    for (const look of await looks(page)) expect(look).not.toMatch(/planned|soon/);
  });

  test('segunda visita: o cartão já nasce pronto, com a resposta ainda a caminho', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(card(page).locator('a.card-link')).toBeVisible();

    await recordPcCard(page);
    const hold = await holdPcStatus(page);
    await page.reload();
    await expect(page.locator('article[data-module="tv"]')).toBeVisible();
    await expect.poll(() => hold.asked()).toBe(true);
    // Sem esperar a API: o estado lembrado da conta já abre o cartão.
    await expect(card(page).locator('a.card-link')).toBeVisible();
    hold.release();
    await settle(page);
    const all = await looks(page);
    expect(all.filter((look) => look !== 'absent')[0]).toBe('card+link');
    for (const look of all) expect(look).not.toMatch(/planned|soon/);
  });

  test('conta sem computador: o cartão não aparece pronto para depois virar "Em Breve"', async ({
    page,
  }) => {
    pc.status = { available: false, online: false, apps: [] };
    await recordPcCard(page);
    const hold = await holdPcStatus(page);
    await page.goto('/');
    await expect.poll(() => hold.asked()).toBe(true);
    hold.release();
    await settle(page);
    await expect(page.locator('article[data-module="tv"]')).toBeVisible();
    for (const look of await looks(page)) expect(look).not.toMatch(/link/);
  });

  test('a resposta que falha nunca vira um computador: o cartão fica "Em Breve" e não abre nada', async ({
    page,
  }) => {
    await recordPcCard(page);
    await page.route('**/api/v1/pc/status', (route) => route.abort('connectionreset'));
    await page.goto('/');
    await expect(page.locator('article[data-module="tv"]')).toBeVisible();
    await expect(card(page)).toContainText('Em Breve');
    await settle(page);
    for (const look of await looks(page)) expect(look).not.toMatch(/link/);
  });

  test('print da Início para comparar antes e depois', async ({ page }, info) => {
    test.skip(!SHOTS, 'só com HOME_SHOTS');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(card(page).locator('.ico')).toBeVisible();
    await settle(page);
    await screenshot(page, `${SHOTS}/home-${TAG}-${info.project.name}-dark.png`);
  });
});

test.describe('Início: ativos primeiro e "em breve" só os que o administrador liberou', () => {
  const titles = (page: Page) => page.locator('article.card h3');

  test('por padrão só os módulos que funcionam aparecem, sem nenhum "Em Breve"', async ({
    page,
  }) => {
    identity.soonModules = [];
    pc.status = { available: false, online: false, apps: [] };
    await page.goto('/');
    await expect(titles(page)).toHaveText(['TV', 'Treino', 'Compras']);
    await expect(page.locator('app-home-soon-badge')).toHaveCount(0);
    await expect(page.locator('article.card.planned')).toHaveCount(0);
  });

  test('o que o administrador libera aparece depois dos que funcionam', async ({ page }) => {
    identity.soonModules = ['backup', 'health'];
    pc.status = { available: false, online: false, apps: [] };
    await page.goto('/');
    await expect(titles(page)).toHaveText([
      'TV',
      'Treino',
      'Compras',
      'Saúde e Eventos',
      'Backup de Fotos',
    ]);
    await expect(page.locator('article.card.planned app-home-soon-badge')).toHaveCount(2);
  });

  test('o Controle do PC, quando funciona, entra junto dos ativos e antes de qualquer "em breve"', async ({
    page,
  }) => {
    identity.soonModules = ['health'];
    await page.goto('/');
    await expect(titles(page)).toHaveText([
      'TV',
      'Treino',
      'Compras',
      'Controle do PC',
      'Saúde e Eventos',
    ]);
  });
});
