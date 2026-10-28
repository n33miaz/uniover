import { Locator, Page } from '@playwright/test';
import { mockIdentityApi } from '../auth/identity-mock';
import { expect, screenshot, test } from '../fixtures';
import { mockAuditApi } from '../settings/audit-mock';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
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
async function expectClearOfBottom(page: Page, target: Locator, inset = HOME_INDICATOR) {
  await target.scrollIntoViewIfNeeded();
  const viewport = page.viewportSize()!;
  const box = (await target.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - inset + 0.5);
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
