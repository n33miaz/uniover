import { mockIdentityApi, OWNER } from './auth/identity-mock';
import { expect, expectNoHorizontalScroll, test } from './fixtures';

test.use({ serviceWorkers: 'block' });

test('keeps a text-only share through sign-in and lists it once after reload', async ({
  context,
  page,
  request,
}) => {
  await mockIdentityApi(context);
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  const { action, params, method } = manifest.share_target;
  expect(method).toBe('GET');
  const text = 'Assista https://youtu.be/video123?t=20&si=abc';
  const query = new URLSearchParams({
    [params.url]: '',
    [params.text]: text,
    [params.title]: 'Receita',
  });
  await page.goto(action + '?' + query);
  await expect(page).toHaveURL(/\/entrar\?next=%2Fvideos$/);
  await page.reload();
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();

  await expect(page).toHaveURL(/\/videos$/);
  const item = page.locator('.item-card');
  await expect(item).toHaveCount(1);
  await expect(item.getByRole('link', { name: 'Abrir' })).toHaveAttribute(
    'href',
    'https://www.youtube.com/watch?v=video123&t=20',
  );
  await expect(item).toContainText(text);
  await expectNoHorizontalScroll(page);
  await page.reload();
  await expect(item).toHaveCount(1);
  await item.getByRole('button', { name: /Excluir link/ }).click();
  await expect(page.getByText('Nenhum link na caixa ainda')).toBeVisible();
});
