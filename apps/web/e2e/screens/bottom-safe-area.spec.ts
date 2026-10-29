import { Locator, Page } from '@playwright/test';
import { OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, screenshot, test } from '../fixtures';
import { mockAuditApi } from '../settings/audit-mock';
import { emitSse, installFakeEventSource, mockTvApi, sseUrls } from '../tv/tv-mock';
import { beginWorkout, installClock, openToday, stubDevice } from '../training/support/today-pages';
import { startTraining } from '../training/support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

/**
 * Playwright não simula `env(safe-area-inset-bottom)`; o app lê a área segura de `--safe-inset` (styles.css), então o
 * teste põe nela o home indicator de um iPhone (34 px) e confere que tudo que fica embaixo o respeita.
 */
const HOME_INDICATOR = 34;

async function simulateInset(page: Page, px = HOME_INDICATOR): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.style.setProperty('--safe-inset', `${value}px`);
  }, px);
}

/** O elemento cabe inteiro acima da área segura e nada o cobre no ponto do meio. */
async function expectClearOfBottom(
  page: Page,
  target: Locator,
  inset = HOME_INDICATOR,
  // O aviso passageiro tem `pointer-events: none` (nada o cobre, mas elementFromPoint também não o vê).
  checkCover = true,
) {
  await target.scrollIntoViewIfNeeded();
  const viewport = page.viewportSize()!;
  const box = (await target.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - inset + 0.5);
  if (!checkCover) return;
  const covered = await target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return !top || !(node === top || node.contains(top) || top.contains(node));
  });
  expect(covered, 'algo cobre o controle').toBe(false);
}

test.describe('o que fica embaixo respeita a área segura', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('o botão Entrar fica acima da área segura ao rolar até o fim', async ({ context, page }) => {
    await mockIdentityApi(context);
    await page.goto('/entrar');
    await expect(page.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
    await simulateInset(page);
    await expectClearOfBottom(page, page.getByRole('button', { name: 'Entrar', exact: true }));
  });

  test('a folha de filtros mantém o rodapé de ações à vista', async ({ context, page }) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    await mockTvApi(context, identity);
    const audit = await mockAuditApi(context, identity);
    audit.items = [];
    await installFakeEventSource(page);
    await page.goto('/ajustes/auditoria');
    await page.getByRole('button', { name: /^Filtros/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Filtros' });
    await expect(sheet).toBeVisible();
    await simulateInset(page);
    await expectClearOfBottom(page, sheet.getByRole('button', { name: 'Cancelar' }));
    await expectClearOfBottom(page, sheet.getByRole('button', { name: 'Aplicar' }));
  });

  test('o treino ao vivo mantém o botão Concluir Série e a barra de baixo à vista', async ({
    context,
    page,
  }, info) => {
    await installClock(page);
    await stubDevice(page, { vibrate: true });
    await startTraining(context, page);
    await openToday(page, { history: false });
    await beginWorkout(page);
    await simulateInset(page);
    await expectClearOfBottom(page, page.getByRole('button', { name: 'Concluir Série' }));
    await screenshot(page, `test-results/bottom-safe-area/live-session-${info.project.name}.png`);
  });

  test('o conteúdo do treino ao vivo não soma a área segura duas vezes', async ({
    context,
    page,
  }) => {
    await installClock(page);
    await stubDevice(page, { vibrate: true });
    await startTraining(context, page);
    await openToday(page, { history: false });
    await beginWorkout(page);
    await simulateInset(page);
    const spacing = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>('app-training-page .content')!;
      const live = document.querySelector<HTMLElement>('app-live-session .live')!;
      return {
        shell: getComputedStyle(shell).paddingBottom,
        live: getComputedStyle(live).paddingBottom,
      };
    });
    expect(spacing.shell).toContain('px');
    expect(spacing.live).toBe('96px');
  });

  test('a barra de abas do Treino fica acima da área segura', async ({ context, page }, info) => {
    await startTraining(context, page);
    await openToday(page, { history: false });
    await simulateInset(page);
    const tabs = page.locator('app-tab-bar nav');
    await expect(tabs).toBeVisible();
    await expectClearOfBottom(page, tabs.getByRole('link').first());
    await screenshot(page, `test-results/bottom-safe-area/tab-bar-${info.project.name}.png`);
  });

  test('sem inset informado o piso do app instalado vale e os rodapés não colam na borda', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openToday(page, { history: false });
    // `--safe-bottom` nunca é menor que o piso, e o piso vale mesmo com inset 0.
    const value = await page.evaluate(() => {
      const root = document.documentElement;
      root.style.setProperty('--safe-inset', '0px');
      root.style.setProperty('--safe-floor', '8px');
      const probe = document.createElement('div');
      probe.style.paddingBottom = 'var(--safe-bottom)';
      document.body.append(probe);
      const padding = getComputedStyle(probe).paddingBottom;
      probe.remove();
      return padding;
    });
    expect(value).toBe('8px');
  });
});

/**
 * Teclado virtual simulado: o Playwright não abre teclado, então a página ganha um `visualViewport` falso, cuja altura
 * é a da janela menos o que o teclado cobre. `cover(px)` muda a altura e dispara o `resize` que o app escuta.
 */
const KEYBOARD = 300;

async function installFakeKeyboard(page: Page): Promise<void> {
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
}

async function cover(page: Page, px = KEYBOARD): Promise<void> {
  await page.evaluate(
    (value) => (window as never as { __cover(px: number): void }).__cover(value),
    px,
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--kb-inset'),
      ),
    )
    .toBe(`${px}px`);
}

test.describe('com o teclado aberto o que fica embaixo sobe com ele', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installFakeKeyboard(page);
  });

  test('o dock fixo do treino ao vivo fica acima do teclado', async ({ context, page }) => {
    await installClock(page);
    await stubDevice(page, { vibrate: true });
    await startTraining(context, page);
    await openToday(page, { history: false });
    await beginWorkout(page);
    await cover(page);
    await expectClearOfBottom(page, page.getByRole('button', { name: 'Concluir Série' }), KEYBOARD);
  });

  test('a folha mantém o rodapé sticky acima do teclado e cabe na parte visível', async ({
    context,
    page,
  }) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    await mockTvApi(context, identity);
    const audit = await mockAuditApi(context, identity);
    audit.items = [];
    await installFakeEventSource(page);
    await page.goto('/ajustes/auditoria');
    await page.getByRole('button', { name: /^Filtros/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Filtros' });
    await expect(sheet).toBeVisible();
    await cover(page);
    await expectClearOfBottom(page, sheet.getByRole('button', { name: 'Cancelar' }), KEYBOARD);
    await expectClearOfBottom(page, sheet.getByRole('button', { name: 'Aplicar' }), KEYBOARD);
    const top = (await sheet.boundingBox())!.y;
    expect(top).toBeGreaterThanOrEqual(0);
  });

  test('a barra de abas fica acima do teclado', async ({ context, page }) => {
    await startTraining(context, page);
    await openToday(page, { history: false });
    await cover(page);
    await expectClearOfBottom(
      page,
      page.locator('app-tab-bar nav').getByRole('link').first(),
      KEYBOARD,
    );
  });

  test('o aviso passageiro da TV fica acima do teclado', async ({ context, page }) => {
    const identity = await mockIdentityApi(context);
    const tv = await mockTvApi(context, identity);
    await installFakeEventSource(page);
    await page.goto('/entrar');
    await page.getByLabel('E-mail').fill(OWNER.email);
    await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/tv');
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await emitSse(page, 'tv.state', tv.state);
    await emitSse(page, 'tv.shortcuts', tv.shortcuts);
    await cover(page);
    await page.getByRole('button', { name: 'Desligar a TV' }).click();
    await page
      .getByRole('dialog', { name: 'Desligar a TV?' })
      .getByRole('button', { name: 'Desligar', exact: true })
      .click();
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible();
    await expectClearOfBottom(page, toast, KEYBOARD, false);
  });
});
