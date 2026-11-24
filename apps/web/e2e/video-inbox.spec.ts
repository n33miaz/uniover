import { GUEST, mockIdentityApi, OWNER } from './auth/identity-mock';
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

test('redirects a guest without video permission from the inbox to the home page', async ({
  context,
  page,
}) => {
  const identity = await mockIdentityApi(context);
  identity.guests.push({
    ...GUEST,
    id: '00000000-0000-4000-8000-000000000051',
    createdAt: '2026-10-19T15:00:00Z',
    disabledAt: null,
    permissions: ['module:tv', 'tv:control'],
  });
  identity.loggedIn = true;
  identity.role = 'guest';

  await page.goto('/videos');

  await expect(page).toHaveURL('/');
  await expect(page.locator('app-home-page')).toBeVisible();
  await expect(page.locator('app-video-inbox-page')).toBeHidden();
});
