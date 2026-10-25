import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';
import { IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { settle } from '../screens/screen-helpers';
import { DevicesMock, RATE_LIMITED_CODE, mockDevicesApi } from './devices-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

let identity: IdentityMock;
let devices: DevicesMock;

test.beforeEach(async ({ context }) => {
  identity = await mockIdentityApi(context);
  devices = await mockDevicesApi(context, identity);
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
}

async function signIn(page: Page) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Entra, (no Chromium) cadastra uma passkey no autenticador virtual e abre Ajustes > Aparelhos. */
async function openDevices(page: Page, browserName: string) {
  if (browserName === 'chromium') await addVirtualAuthenticator(page);
  await signIn(page);
  if (browserName === 'chromium') {
    await page.goto('/ajustes/seguranca');
    await page.getByRole('button', { name: 'Cadastrar passkey' }).click();
    await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
    await page.getByLabel('Nome da passkey (opcional)').fill('Notebook');
    await page.getByRole('button', { name: 'Cadastrar', exact: true }).click();
    await expect(page.getByText('Passkey cadastrada.', { exact: true })).toBeVisible();
  }
  await page.goto('/ajustes');
  await page.getByRole('link', { name: /^Aparelhos/ }).click();
  await expect(page).toHaveURL(/\/ajustes\/aparelhos$/);
  await expect(page.getByRole('heading', { level: 2, name: 'Aparelhos pareados' })).toBeVisible();
}

async function typeCode(page: Page, code: string) {
  await page.getByLabel('Código do aparelho').fill(code);
}

function seriousViolations(violations: { id: string; impact?: string | null }[]) {
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => v.id);
}

test.describe('aparelhos', () => {
  test('mostra o vazio explicativo e cabe na tela', async ({ page, browserName }, info) => {
    await openDevices(page, browserName);
    await expect(
      page.getByText(
        'Nenhum aparelho pareado. Rode o agente no PC e digite o código que ele mostrar.',
      ),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
    // A tela chega com a entrada escalonada: o print só vale depois dela.
    await settle(page);
    await screenshot(page, `test-results/devices-empty-${info.project.name}.png`);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(seriousViolations(violations)).toEqual([]);
  });

  test('pareia com a passkey: o código vale em minúsculas e sem hífen; o pedido é repetido uma vez', async ({
    page,
    browserName,
  }, info) => {
    devices.openCodes.add('BCDF2345');
    await openDevices(page, browserName);
    // No WebKit não há autenticador virtual: só o passo da passkey é pulado (a confirmação já vale).
    if (browserName !== 'chromium') identity.stepUpValid = true;

    await page.getByRole('button', { name: 'Parear aparelho' }).click();
    const sheet = page.getByRole('dialog', { name: 'Parear aparelho' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: /fechar|close/i })).toHaveCount(0);
    const code = sheet.getByLabel('Código do aparelho');
    await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    await expect(sheet.getByLabel('Nome do aparelho')).toHaveValue('PC de casa');
    await expect(sheet.getByRole('button', { name: 'Aprovar' })).toBeDisabled();

    await code.fill('bcdf2345');
    await expect(code).toHaveValue('BCDF-2345');
    await expectNoHorizontalScroll(page);
    await settle(page);
    await screenshot(page, `test-results/devices-sheet-${info.project.name}.png`);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(seriousViolations(violations)).toEqual([]);

    await sheet.getByRole('button', { name: 'Aprovar' }).click();

    if (browserName === 'chromium') {
      const dialog = page.getByRole('dialog', { name: 'Confirmar com passkey' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('ligar um computador à TV');
      await dialog.getByRole('button', { name: 'Confirmar' }).click();
    }

    await expect(page.getByText('Aparelho PC de casa pareado.')).toBeVisible();
    await expect(sheet).toHaveCount(0);
    await expect(page.locator('.item .name')).toHaveText(['PC de casa']);
    await expect(page.locator('.item')).toContainText('Ativo');

    const approvals = devices.requests.filter((r) => r.path === '/pairing/approve');
    expect(approvals.map((r) => r.body)).toEqual(
      Array(browserName === 'chromium' ? 2 : 1).fill({
        userCode: 'BCDF2345',
        name: 'PC de casa',
        tvName: null,
        tvMemberIds: [],
      }),
    );
    if (browserName === 'chromium') {
      expect(identity.requests.some((r) => r.path === '/step-up/complete')).toBe(true);
    }
    expect(devices.openCodes.size).toBe(0);
    await expectNoHorizontalScroll(page);
  });

  test('cancelar a passkey não pareia nem repete o pedido', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'a passkey virtual só existe no Chromium');
    devices.openCodes.add('BCDF2345');
    await openDevices(page, browserName);

    await page.getByRole('button', { name: 'Parear aparelho' }).click();
    const sheet = page.getByRole('dialog', { name: 'Parear aparelho' });
    await typeCode(page, 'BCDF-2345');
    await sheet.getByRole('button', { name: 'Aprovar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirmar com passkey' });
    await dialog.getByRole('button', { name: 'Cancelar' }).click();

    await expect(
      page.getByText('A aprovação não foi confirmada com a passkey. Nada foi pareado.'),
    ).toBeVisible();
    expect(devices.requests.filter((r) => r.path === '/pairing/approve')).toHaveLength(1);
    expect(identity.requests.some((r) => r.path === '/step-up/complete')).toBe(false);
    expect(devices.agents).toHaveLength(0);
    // A folha continua aberta para tentar de novo.
    await expect(sheet).toBeVisible();
  });

  test('explica código inválido ou vencido e excesso de tentativas', async ({
    page,
    browserName,
  }) => {
    await openDevices(page, browserName);
    identity.stepUpValid = true;
    await page.getByRole('button', { name: 'Parear aparelho' }).click();
    const sheet = page.getByRole('dialog', { name: 'Parear aparelho' });

    await typeCode(page, 'BCDF-2345');
    await sheet.getByRole('button', { name: 'Aprovar' }).click();
    await expect(sheet.getByText('Código inválido ou vencido.')).toBeVisible();

    await typeCode(page, RATE_LIMITED_CODE);
    await sheet.getByRole('button', { name: 'Aprovar' }).click();
    await expect(
      sheet.getByText('Muitas tentativas seguidas. Tente de novo em 7 s.'),
    ).toBeVisible();
    expect(devices.agents).toHaveLength(0);
  });

  test('tocar no fundo fecha a folha de pareamento e devolve o foco ao botão que a abriu', async ({
    page,
    browserName,
  }) => {
    await openDevices(page, browserName);
    const opener = page.getByRole('button', { name: 'Parear aparelho' });
    await opener.focus(); // o WebKit não dá foco ao botão no toque; pelo teclado há para onde voltar
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Parear aparelho' });
    await expect(sheet).toBeVisible();

    await sheet.getByRole('heading', { name: 'Parear aparelho' }).click();
    await expect(sheet).toBeVisible(); // toque dentro da folha não fecha
    await page.mouse.click(4, 4); // fora do retângulo da folha
    await expect(sheet).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(devices.requests.some((r) => r.path === '/pairing/approve')).toBe(false);
  });

  test('recusa um código sem pedir a passkey', async ({ page, browserName }) => {
    devices.openCodes.add('BCDF2345');
    await openDevices(page, browserName);
    await page.getByRole('button', { name: 'Parear aparelho' }).click();
    const sheet = page.getByRole('dialog', { name: 'Parear aparelho' });
    await typeCode(page, 'bcdf2345');
    await sheet.getByRole('button', { name: 'Recusar código' }).click();

    await expect(page.getByText('Código recusado. Nenhum aparelho foi pareado.')).toBeVisible();
    await expect(sheet).toHaveCount(0);
    expect(devices.requests.filter((r) => r.path === '/pairing/deny')).toHaveLength(1);
    expect(devices.requests.some((r) => r.path === '/pairing/approve')).toBe(false);
    expect(identity.requests.some((r) => r.path.startsWith('/step-up'))).toBe(false);
    expect(devices.openCodes.size).toBe(0);
  });

  test('revoga sem passkey, com confirmação em linha', async ({ page, browserName }) => {
    devices.agents.push({
      id: '00000000-0000-4000-8000-000000000001',
      slug: 'agent:pc-de-casa',
      name: 'PC de casa',
      platform: 'windows',
      createdAt: '2026-10-18T12:00:00Z',
      revoked: false,
      lastSeenAt: '2026-10-18T15:30:00Z',
    });
    await openDevices(page, browserName);
    await expect(page.locator('.item .name')).toHaveText(['PC de casa']);
    await expect(page.locator('.item .last-seen')).toContainText('Último uso em');

    await page.getByRole('button', { name: 'Revogar PC de casa' }).click();
    await expect(
      page.getByText('Revogar o PC de casa? Ele para de receber comandos na hora.'),
    ).toBeVisible();
    expect(devices.requests.some((r) => r.path.endsWith('/revoke'))).toBe(false);
    await page.getByRole('button', { name: 'Revogar', exact: true }).click();

    await expect(page.getByText('Aparelho revogado.')).toBeVisible();
    await expect(page.locator('.item .chip')).toHaveText('Revogado');
    await expect(page.getByRole('button', { name: /^Revogar/ })).toHaveCount(0);
    expect(devices.agents[0].revoked).toBe(true);
    expect(identity.requests.some((r) => r.path.startsWith('/step-up'))).toBe(false);
    await expect(page.getByRole('dialog', { name: 'Confirmar com passkey' })).toHaveCount(0);

    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(seriousViolations(violations)).toEqual([]);
  });

  test('sem rede, parear e revogar ficam desabilitados e a tela explica', async ({
    page,
    context,
    browserName,
  }) => {
    devices.agents.push({
      id: '00000000-0000-4000-8000-000000000001',
      slug: 'agent:pc-de-casa',
      name: 'PC de casa',
      platform: 'windows',
      createdAt: '2026-10-18T12:00:00Z',
      revoked: false,
      lastSeenAt: '2026-10-18T15:30:00Z',
    });
    await openDevices(page, browserName);
    await expect(page.getByRole('button', { name: 'Parear aparelho' })).toBeEnabled();

    await context.setOffline(true);
    await expect(page.getByRole('button', { name: 'Parear aparelho' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Revogar PC de casa' })).toBeDisabled();
    await expect(
      page.getByText('Sem conexão: parear, recusar e revogar precisam de rede.'),
    ).toBeVisible();

    await context.setOffline(false);
    await expect(page.getByRole('button', { name: 'Parear aparelho' })).toBeEnabled();
  });
});
