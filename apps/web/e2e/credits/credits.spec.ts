import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';
import { OWNER, mockIdentityApi } from '../auth/identity-mock';
import {
  expect,
  expectNoHorizontalScroll,
  screenshot,
  test,
  waitForServiceWorkerControl,
} from '../fixtures';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ context }) => {
  await mockIdentityApi(context);
});

async function signIn(page: Page) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

function seriousViolations(
  violations: { id: string; impact?: string | null; nodes: { target: unknown[] }[] }[],
) {
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

test.describe('créditos', () => {
  test('abre por Ajustes e mostra título, autor, fonte e licença de cada material', async ({
    page,
  }, info) => {
    await signIn(page);
    await page.goto('/ajustes');
    await page.getByRole('link', { name: /^Créditos/ }).click();
    await expect(page).toHaveURL(/\/ajustes\/creditos$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Créditos' })).toBeVisible();

    const everkinetic = page.locator('.list > li', { hasText: 'Everkinetic' });
    await expect(everkinetic).toContainText('Greg Priday');
    await expect(everkinetic).toContainText('CC BY-SA 4.0');
    await expect(everkinetic).toContainText('Sem alterações');
    await expect(everkinetic.getByRole('link', { name: 'CC BY-SA 4.0' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by-sa/4.0/',
    );
    await expect(everkinetic.getByRole('link', { name: 'CC BY-SA 4.0' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );

    const freeDb = page.locator('.list > li', { hasText: 'free-exercise-db' });
    await expect(freeDb).toContainText('Unlicense');
    await expect(freeDb).toContainText('As imagens dessa fonte não são usadas');

    // Sem exercício do wger no aparelho, a seção dele não aparece.
    await expect(page.getByText('wger: exercícios importados')).toHaveCount(0);

    await expectNoHorizontalScroll(page);
    await screenshot(page, `test-results/credits-${info.project.name}.png`);

    await page.getByRole('link', { name: /Ajustes/ }).click();
    await expect(page).toHaveURL(/\/ajustes$/);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`sem violações sérias de acessibilidade no tema ${scheme === 'light' ? 'claro' : 'escuro'}`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await signIn(page);
      await page.goto('/ajustes/creditos');
      await expect(page.getByRole('heading', { level: 1, name: 'Créditos' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      await expectNoHorizontalScroll(page);
      await screenshot(page, `test-results/credits-${scheme}-${info.project.name}.png`);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(seriousViolations(violations)).toEqual([]);
    });
  }

  test('os alvos de toque dos links têm pelo menos 44 px de altura', async ({ page }) => {
    await signIn(page);
    await page.goto('/ajustes/creditos');
    await expect(page.getByRole('heading', { level: 1, name: 'Créditos' })).toBeVisible();
    const links = page.locator('.list a, a.back');
    const count = await links.count();
    expect(count).toBeGreaterThanOrEqual(5);
    for (let index = 0; index < count; index += 1) {
      const box = await links.nth(index).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('créditos sem conexão', () => {
  test.use({ serviceWorkers: 'allow' });

  test('depois de uma visita, a tela abre com a rede fora', async ({ page, context }) => {
    // Sem API simulada aqui: o que se prova é o comportamento do app com a rede de fato fora.
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await page.goto('/');
    await waitForServiceWorkerControl(page);

    await context.setOffline(true);
    await page.goto('/ajustes/creditos');
    await expect(page).toHaveURL(/\/ajustes\/creditos$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Créditos' })).toBeVisible();
    await expect(page.locator('.list > li', { hasText: 'Everkinetic' })).toContainText(
      'Greg Priday',
    );
    await expect(page.locator('.list > li', { hasText: 'free-exercise-db' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await context.setOffline(false);
  });
});
