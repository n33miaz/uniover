import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { mockIdentityApi } from './identity-mock';

test.use({ serviceWorkers: 'block' });

for (const width of [280, 320]) {
  test(`pedido de recuperação cabe na tela de ${width} px`, async ({ page, context }) => {
    await mockIdentityApi(context);
    await page.setViewportSize({ width, height: 568 });
    await page.goto('/recuperar-senha');
    await expect(page.getByRole('heading', { name: 'Recuperar senha' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar link' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test(`redefinição tira o segredo do endereço e cabe em ${width} px`, async ({ page, context }) => {
    await mockIdentityApi(context);
    await page.setViewportSize({ width, height: 568 });
    await page.goto(`/redefinir-senha#token=${'a'.repeat(43)}`);
    await expect(page.getByRole('heading', { name: 'Escolher nova senha' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Salvar nova senha' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    await expectNoHorizontalScroll(page);
  });
}
