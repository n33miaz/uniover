import AxeBuilder from '@axe-core/playwright';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { OWNER, mockIdentityApi } from './identity-mock';

test.use({ serviceWorkers: 'block' });

test('the owner reviews and ends another session in Security', async ({ page, context }, info) => {
  const mock = await mockIdentityApi(context);
  mock.sessions.push({
    id: '00000000-0000-4000-8000-000000000002',
    userAgent: 'Mozilla/5.0 (Windows) Chrome/120',
    ip: '198.51.100.0/24',
    createdAt: '2026-10-24T10:00:00Z',
    lastUsedAt: '2026-10-25T10:00:00Z',
    isCurrent: false,
  });
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.goto('/ajustes/seguranca');
  await expect(page.getByRole('heading', { name: 'Aparelhos com Acesso' })).toBeVisible();
  await expect(page.getByText('Chrome · Windows')).toBeVisible();
  await expectNoHorizontalScroll(page);
  // Os detalhes (e o Encerrar de cada sessão) vêm dobrados: o Chromium não dá caixa ao que está fechado, então abre-se tudo
  // para medir o alvo de toque que a pessoa de fato alcança.
  const summaries = page.locator('app-sessions-section summary');
  for (const summary of await summaries.all()) await summary.click();
  await expect(page.locator('app-sessions-section details:not([open])')).toHaveCount(0);
  const smallTargets = await page.locator('app-sessions-section button').evaluateAll(
    (buttons) =>
      buttons.filter((button) => {
        const bounds = button.getBoundingClientRect();
        return bounds.width < 44 || bounds.height < 44;
      }).length,
  );
  expect(smallTargets).toBe(0);
  const violations = (await new AxeBuilder({ page }).analyze()).violations;
  expect(violations.map((violation) => violation.id)).toEqual([]);
  await screenshot(page, `test-results/sessions-${info.project.name}.png`, { fullPage: true });

  await page.getByRole('button', { name: 'Encerrar os Outros' }).click();
  expect(mock.sessions).toHaveLength(2);
  await page
    .getByRole('group', { name: 'Confirmar outros acessos' })
    .getByRole('button', { name: 'Encerrar os Outros' })
    .click();
  await expect(page.getByText('Chrome · Windows')).toHaveCount(0);
  expect(mock.sessions).toHaveLength(1);
});

test('the owner ends a guest session without revoking the account', async ({ page, context }) => {
  const mock = await mockIdentityApi(context);
  const guestId = '00000000-0000-4000-8000-000000000050';
  mock.guests.push({
    id: guestId,
    displayName: 'Bia',
    email: 'bia@exemplo.com',
    password: 'senha-de-teste-123',
    createdAt: '2026-10-24T10:00:00Z',
    disabledAt: null,
  });
  mock.guestSessions[guestId] = [
    {
      id: '00000000-0000-4000-8000-000000000099',
      userAgent: 'Mozilla/5.0 (Android) Chrome/120',
      ip: '203.0.113.0/24',
      createdAt: '2026-10-25T10:00:00Z',
      lastUsedAt: '2026-10-25T10:00:00Z',
      isCurrent: false,
    },
  ];
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.goto('/ajustes/pessoas');
  await page.getByRole('button', { name: 'Acessos' }).click();
  await expect(page.getByRole('heading', { name: 'Acessos de Bia' })).toBeVisible();
  await expect(page.getByText('Chrome · Android')).toBeVisible();
  await expectNoHorizontalScroll(page);
  // Os detalhes e o Encerrar vêm dobrados atrás do nome do aparelho.
  await page.getByText('Chrome · Android').click();
  await page.getByRole('button', { name: 'Encerrar', exact: true }).click();
  await page
    .getByRole('group', { name: 'Confirmar encerramento' })
    .getByRole('button', { name: 'Encerrar', exact: true })
    .click();
  await expect(page.getByText('Nenhum acesso ativo.')).toBeVisible();
  expect(mock.guests[0].disabledAt).toBeNull();
});
