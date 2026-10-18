import { expect, test, Page } from '@playwright/test';

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test('home grid, navigate to TV and back, no horizontal scroll', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await expect(page.locator('a.card')).toHaveCount(2);
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: `test-results/home-${info.project.name}.png` });

  await page.locator('a.card[data-module="tv"]').click();
  await expect(page).toHaveURL(/\/tv$/);
  await expect(page.getByRole('heading', { name: 'TV' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: `test-results/tv-${info.project.name}.png` });

  await page.getByRole('link', { name: /Início/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('a.card')).toHaveCount(2);
});

test('follows the system dark theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
