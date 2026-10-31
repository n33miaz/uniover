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
  test('abre por Configurações e mostra título, autor, fonte e licença de cada material', async ({
    page,
  }, info) => {
    // Movimento reduzido: a folha já aparece parada, sem esperar a subida (e o print sai nítido).
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signIn(page);
    await page.goto('/ajustes/sobre');
    await page.getByRole('link', { name: /^Créditos/ }).click();
    await expect(page).toHaveURL(/\/ajustes\/sobre\/creditos$/);
    await expect(page.getByRole('dialog', { name: 'Créditos' })).toBeVisible();

    // Cada fonte vem recolhida, com o título e a licença à vista: o toque abre.
    const closed = page.locator('.list > li', { hasText: 'Everkinetic' });
    await expect(closed.locator('summary')).toContainText('CC BY-SA 4.0');
    await expect(closed.getByRole('link')).toHaveCount(0);
    await screenshot(page, `test-results/credits-folha-${info.project.name}.png`);
    const everkinetic = page.locator('.list > li', { hasText: 'Everkinetic' });
    await everkinetic.locator('summary').click();
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
    await freeDb.locator('summary').click();
    await expect(freeDb).toContainText('Unlicense');
    await expect(freeDb).toContainText('As imagens dessa fonte não são usadas');

    // Sem exercício do wger no aparelho, a seção dele não aparece.
    await expect(page.getByText('wger: exercícios importados')).toHaveCount(0);

    await expectNoHorizontalScroll(page);
    await screenshot(page, `test-results/credits-${info.project.name}.png`);

    // Fechar a folha volta para Sobre; de lá, a seta leva à lista de Configurações.
    await page.getByRole('button', { name: 'Fechar' }).click();
    await expect(page).toHaveURL(/\/ajustes\/sobre$/);
    await page.getByRole('button', { name: 'Voltar às Configurações' }).click();
    await expect(page).toHaveURL(/\/ajustes$/);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`sem violações sérias de acessibilidade no tema ${scheme === 'light' ? 'claro' : 'escuro'}`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await signIn(page);
      await page.goto('/ajustes/creditos');
      await expect(page.getByRole('dialog', { name: 'Créditos' })).toBeVisible();
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
    await expect(page.getByRole('dialog', { name: 'Créditos' })).toBeVisible();
    for (const summary of await page.locator('.list summary').all()) await summary.click();
    const links = page.locator('.list a');
    const count = await links.count();
    expect(count).toBeGreaterThanOrEqual(4);
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
    await expect(page).toHaveURL(/\/ajustes\/sobre\/creditos$/);
    await expect(page.getByRole('dialog', { name: 'Créditos' })).toBeVisible();
    await page.locator('.list > li', { hasText: 'Everkinetic' }).locator('summary').click();
    await expect(page.locator('.list > li', { hasText: 'Everkinetic' })).toContainText(
      'Greg Priday',
    );
    await expect(page.locator('.list > li', { hasText: 'free-exercise-db' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await context.setOffline(false);
  });
});
