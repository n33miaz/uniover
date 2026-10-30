import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';
import { expect, screenshot, test } from '../fixtures';
import { IdentityMock, OWNER, TV_CONTROL_ONLY, mockIdentityApi } from './identity-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

let mock: IdentityMock;

test.beforeEach(async ({ context, browserName }) => {
  // O autenticador virtual vem do protocolo do Chromium; no WebKit a verificação é no aparelho.
  test.skip(browserName !== 'chromium', 'autenticador virtual só existe no Chromium');
  mock = await mockIdentityApi(context);
});

async function addVirtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return cdp;
}

async function registerPasskey(page: Page, name: string) {
  await page.getByRole('button', { name: 'Cadastrar passkey' }).click();
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByLabel('Nome da passkey (opcional)').fill(name);
  await page.getByRole('button', { name: 'Cadastrar', exact: true }).click();
  // `exact`: sem ele o texto também casa com "Nenhuma passkey cadastrada." e o teste seguiria antes de a passkey existir.
  await expect(page.getByText('Passkey cadastrada.', { exact: true })).toBeVisible();
}

test.describe('passkeys e confirmação', () => {
  test.beforeEach(async ({ page }) => {
    await addVirtualAuthenticator(page);
    await page.goto('/entrar');
    await page.getByLabel('E-mail').fill(OWNER.email);
    await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/ajustes/seguranca');
    await expect(page.getByRole('heading', { level: 2, name: 'Passkeys' })).toBeVisible();
  });

  test('cadastra duas passkeys pedindo a senha de novo', async ({ page }) => {
    await expect(page.getByText('Nenhuma passkey cadastrada.')).toBeVisible();

    // Senha errada: mensagem clara e nenhuma passkey criada.
    await page.getByRole('button', { name: 'Cadastrar passkey' }).click();
    await page.getByLabel('Senha', { exact: true }).fill('errada');
    await page.getByRole('button', { name: 'Cadastrar', exact: true }).click();
    await expect(page.getByText('Senha incorreta.')).toBeVisible();
    expect(mock.passkeys).toHaveLength(0);
    await page.getByRole('button', { name: 'Cancelar' }).click();

    await registerPasskey(page, 'Notebook');
    await expect(page.locator('.item .name')).toHaveText(['Notebook']);
    await expect(page.getByText('Tenha ao menos duas passkeys')).toBeVisible();
    await registerPasskey(page, 'Celular');
    await expect(page.locator('.item .name')).toHaveText(['Notebook', 'Celular']);
    await expect(page.getByText('Tenha ao menos duas passkeys')).toHaveCount(0);
    expect(mock.passkeys.every((p) => p.rawId.length > 0)).toBe(true);
  });

  test('remover pede a confirmação com a passkey, acessível, e só então remove', async ({
    page,
  }, info) => {
    await registerPasskey(page, 'Notebook');
    await registerPasskey(page, 'Celular');

    await page.getByRole('button', { name: 'Remover Notebook' }).click();
    await expect(page.getByText('Remover a passkey Notebook?')).toBeVisible();
    await page.getByRole('button', { name: 'Remover', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Confirmar com passkey' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('remover uma passkey');
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /fechar|close/i })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Confirmar' })).toBeEnabled();
    await screenshot(page, `test-results/step-up-${info.project.name}.png`);

    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id),
    ).toEqual([]);

    await dialog.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('Passkey removida.')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.item .name')).toHaveText(['Celular']);
    expect(mock.passkeys.map((p) => p.name)).toEqual(['Celular']);

    // O pedido perigoso foi repetido uma única vez, depois da confirmação.
    const deletes = mock.requests.filter((r) => r.method === 'DELETE');
    expect(deletes).toHaveLength(2);
    const order = mock.requests.map((r) => `${r.method} ${r.path}`);
    expect(order.indexOf('POST /step-up/complete')).toBeGreaterThan(
      order.indexOf('DELETE /passkeys/p1'),
    );
  });

  test('cancelar a confirmação mantém a passkey e não repete o pedido', async ({ page }) => {
    await registerPasskey(page, 'Notebook');
    await registerPasskey(page, 'Celular');

    await page.getByRole('button', { name: 'Remover Notebook' }).click();
    await page.getByRole('button', { name: 'Remover', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirmar com passkey' });
    await dialog.getByRole('button', { name: 'Cancelar' }).click();

    await expect(page.getByText('A remoção não foi confirmada com a passkey.')).toBeVisible();
    await expect(page.locator('.item .name')).toHaveText(['Notebook', 'Celular']);
    expect(mock.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
    expect(mock.requests.some((r) => r.path === '/step-up/complete')).toBe(false);
  });

  test('mudar as permissões de uma pessoa pede a passkey, com o título próprio, e repete o pedido uma vez', async ({
    page,
  }, info) => {
    await registerPasskey(page, 'Notebook');
    mock.guests.push({
      id: 'g1',
      displayName: 'Bruno',
      email: 'bruno@exemplo.com',
      password: 'x',
      createdAt: '2026-10-10T10:00:00Z',
      disabledAt: null,
    });
    await page.goto('/ajustes/pessoas');
    await page.getByRole('button', { name: 'Permissões de Bruno' }).click();
    const sheet = page.getByRole('dialog', { name: 'Permissões de Bruno' });
    await sheet.getByRole('switch', { name: 'Usar o Treino' }).check();
    await sheet.getByRole('button', { name: 'Salvar' }).click();

    const dialog = page.getByRole('dialog', { name: 'Confirmar a mudança de permissões' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Para mudar as permissões de uma pessoa, confirme');
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Confirmar' })).toBeEnabled();
    await screenshot(page, `test-results/step-up-permissions-${info.project.name}.png`);

    await dialog.getByRole('button', { name: 'Confirmar' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText('Permissões de Bruno salvas.')).toBeVisible();

    // A API é avisada da ação certa, e o pedido perigoso é repetido uma única vez, depois da confirmação.
    const options = mock.requests.find((r) => r.path === '/step-up/options');
    expect(options?.body).toEqual({ action: 'identity.permissions-change' });
    const puts = mock.requests.filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[1].body).toEqual({ permissions: [...TV_CONTROL_ONLY, 'module:training'] });
    const order = mock.requests.map((r) => `${r.method} ${r.path}`);
    expect(order.indexOf('POST /step-up/complete')).toBeGreaterThan(
      order.indexOf('PUT /guests/g1/permissions'),
    );
    expect(order.lastIndexOf('PUT /guests/g1/permissions')).toBeGreaterThan(
      order.indexOf('POST /step-up/complete'),
    );
  });

  test('o diálogo fecha com Esc e devolve o foco', async ({ page }) => {
    await registerPasskey(page, 'Notebook');
    await registerPasskey(page, 'Celular');
    await page.getByRole('button', { name: 'Remover Notebook' }).click();
    await page.getByRole('button', { name: 'Remover', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirmar com passkey' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(mock.passkeys).toHaveLength(2);
  });
});
