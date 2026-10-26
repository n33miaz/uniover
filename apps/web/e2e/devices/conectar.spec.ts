import AxeBuilder from '@axe-core/playwright';
import { GUEST, IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { settle } from '../screens/screen-helpers';
import { DevicesMock, mockDevicesApi } from './devices-mock';

const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const GUEST_ID = '00000000-0000-4000-8000-000000000051';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

let identity: IdentityMock;
let devices: DevicesMock;

test.beforeEach(async ({ context }) => {
  identity = await mockIdentityApi(context);
  devices = await mockDevicesApi(context, identity);
});

function seriousViolations(violations: { id: string; impact?: string | null }[]) {
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => v.id);
}

function seedGuest(permissions: string[]) {
  identity.guests.push({
    id: GUEST_ID,
    displayName: GUEST.displayName,
    email: GUEST.email,
    password: GUEST.password,
    createdAt: '2026-10-19T15:00:00Z',
    disabledAt: null,
    permissions,
  });
  identity.role = 'guest';
  identity.loggedIn = true;
}

test.describe('página pública /conectar', () => {
  test.describe('no Windows', () => {
    test.use({ userAgent: WINDOWS_UA });

    test('sem login: baixa o conector e mostra os passos e os botões dos avisos', async ({
      page,
    }, info) => {
      await page.goto('/conectar');
      await expect(page).toHaveURL(/\/conectar$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Conectar este PC' })).toBeVisible();

      const link = page.getByRole('link', { name: 'Baixar o conector' });
      await expect(link).toHaveAttribute('href', '/conectar/conectar-uniover.cmd');
      await expect(link).toHaveAttribute('download', 'conectar-uniover.cmd');
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);

      await expect(page.getByText('Abra o arquivo baixado')).toBeVisible();
      await expect(
        page.getByText('Escaneie o QR da tela com o celular de quem administra'),
      ).toBeVisible();
      await expect(page.getByText('Toque em Permitir na TV')).toBeVisible();
      for (const text of [
        'Manter',
        'Manter mesmo assim',
        'Mais informações',
        'Executar assim mesmo',
      ]) {
        await expect(
          page.locator('.warnings strong', { hasText: new RegExp(`^${text}$`) }),
        ).toBeVisible();
      }

      // Nenhuma chamada à API de aparelhos: a página é pública.
      expect(devices.requests).toHaveLength(0);
      await expectNoHorizontalScroll(page);
      await settle(page);
      await screenshot(page, info.outputPath('conectar-windows.png'));
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(seriousViolations(violations)).toEqual([]);

      const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
      expect(download.suggestedFilename()).toBe('conectar-uniover.cmd');
    });

    test('sem login oferece Entrar (e voltar aqui), além do download sem conta', async ({
      page,
    }) => {
      await page.goto('/conectar');
      const login = page.getByRole('link', { name: 'Entrar' });
      await expect(login).toHaveAttribute('href', '/entrar?next=%2Fconectar');
      await expect(page.getByRole('link', { name: 'Baixar o conector' })).toBeVisible();
      await expect(page.getByText('Você entrou como')).toHaveCount(0);

      await login.click();
      await expect(page).toHaveURL(/\/entrar\?next=%2Fconectar$/);
    });

    test('logado mostra quem é, não pede para entrar e abre fora da casca do app', async ({
      page,
    }, info) => {
      identity.loggedIn = true;
      await page.goto('/conectar');
      await expect(page.getByRole('link', { name: 'Baixar o conector' })).toBeVisible();
      await expect(page.locator('app-shell')).toHaveCount(0);
      await expect(page.getByText(`Você entrou como ${identity.owner.displayName}.`)).toBeVisible();
      await expect(page.getByRole('link', { name: 'Entrar' })).toHaveCount(0);
      await expect(
        page.getByText('Na janela que abrir, toque em Aprovar neste computador'),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
      await settle(page);
      await screenshot(page, info.outputPath('conectar-logado.png'));
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(seriousViolations(violations)).toEqual([]);
    });
  });

  test('fora do Windows explica que é para o PC e não oferece o download', async ({
    page,
  }, info) => {
    await page.goto('/conectar');
    await expect(page.getByRole('heading', { level: 1, name: 'Conectar este PC' })).toBeVisible();
    await expect(
      page.getByText('O conector é para PC com Windows. Abra esta página nele.'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Baixar o conector' })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await screenshot(page, info.outputPath('conectar-other.png'));
  });

  test('a tela de login leva a ela, discretamente', async ({ page }) => {
    await page.goto('/entrar');
    await page.getByRole('link', { name: 'Conectar um PC' }).click();
    await expect(page).toHaveURL(/\/conectar$/);
  });
});

test.describe('convidado com a TV', () => {
  test.use({ userAgent: WINDOWS_UA });

  test('vê o botão de baixar o conector em Aparelhos e aprova só o próprio PC, sem lista', async ({
    page,
  }, info) => {
    seedGuest(['module:tv', 'tv:control']);
    await page.goto('/ajustes');
    await page.getByRole('link', { name: /^Aparelhos/ }).click();
    await expect(page).toHaveURL(/\/ajustes\/dispositivos$/);

    await expect(page.getByRole('button', { name: 'Aprovar este computador' })).toBeVisible();
    await expect(page.getByText('Peça ao administrador para aprovar.')).toHaveCount(0);
    const link = page.getByRole('link', { name: 'Baixar conector' });
    await expect(link).toHaveAttribute('href', '/conectar/conectar-uniover.cmd');
    await expect(page.getByRole('button', { name: 'Parear aparelho' })).toHaveCount(0);
    expect(devices.requests).toHaveLength(0);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await screenshot(page, info.outputPath('guest-download.png'));
  });

  test('sem a TV não ganha o botão nem a linha em Ajustes', async ({ page }) => {
    seedGuest(['module:training']);
    await page.goto('/ajustes/dispositivos');
    await expect(page.getByText('Peça ao administrador para aprovar.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Baixar conector' })).toHaveCount(0);
    await page.goto('/ajustes');
    await expect(page.getByRole('link', { name: /^Aparelhos/ })).toHaveCount(0);
  });

  test('aprova o próprio PC: senha de novo, TV só dele e nunca a padrão', async ({
    page,
  }, info) => {
    seedGuest(['module:tv', 'tv:control']);
    devices.openCodes.add('BCDF2345');

    // É o endereço do botão "Aprovar neste computador" da página local do PC.
    await page.goto('/ajustes/dispositivos?codigo=bcdf2345');
    const sheet = page.getByRole('dialog', { name: 'Aprovar este computador' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByLabel('Código do computador')).toHaveValue('BCDF-2345');
    await expect(sheet.getByLabel('Nome da TV')).toHaveValue(`TV de ${GUEST.displayName}`);
    // Nada de escolher pessoas: a TV é só dele.
    await expect(sheet.getByRole('switch')).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Aprovar' })).toBeDisabled();
    await sheet.getByLabel('Sua senha').fill(GUEST.password);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await screenshot(page, info.outputPath('guest-pair-sheet.png'));
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(seriousViolations(violations)).toEqual([]);

    await sheet.getByRole('button', { name: 'Aprovar' }).click();
    await expect(
      page.getByText('Computador conectado. A sua TV já aparece no controle.'),
    ).toBeVisible();

    expect(identity.passwordConfirmations).toEqual([
      { action: 'devices.pair-self', password: GUEST.password },
    ]);
    // A senha vem antes da aprovação e esta não leva lista de pessoas.
    const approve = devices.requests.find((r) => r.path === '/pairing/approve-own')!;
    expect(approve.body).toEqual({
      userCode: 'BCDF2345',
      name: null,
      tvName: `TV de ${GUEST.displayName}`,
    });
    expect(devices.requests.some((r) => r.path === '/pairing/approve')).toBe(false);
    expect(devices.tvs).toEqual([
      {
        name: `TV de ${GUEST.displayName}`,
        agentSlug: devices.agents[0].slug,
        memberIds: [GUEST_ID],
      },
    ]);
  });

  test('a folha de aprovar este computador fecha ao tocar no fundo', async ({ page }) => {
    seedGuest(['module:tv']);
    devices.openCodes.add('BCDF2345');

    await page.goto('/ajustes/dispositivos?codigo=bcdf2345');
    const sheet = page.getByRole('dialog', { name: 'Aprovar este computador' });
    await expect(sheet).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(sheet).toHaveCount(0);
    expect(devices.requests).toHaveLength(0);
  });

  test('senha errada não aprova nada', async ({ page }) => {
    seedGuest(['module:tv']);
    devices.openCodes.add('BCDF2345');

    await page.goto('/ajustes/dispositivos?codigo=bcdf2345');
    const sheet = page.getByRole('dialog', { name: 'Aprovar este computador' });
    await sheet.getByLabel('Sua senha').fill('senha-errada');
    await sheet.getByRole('button', { name: 'Aprovar' }).click();

    await expect(sheet.getByText('Senha incorreta. Confira e tente de novo.')).toBeVisible();
    expect(devices.requests.some((r) => r.path === '/pairing/approve-own')).toBe(false);
    expect(devices.agents).toEqual([]);
    expect(devices.openCodes.has('BCDF2345')).toBe(true);
  });

  test('no limite de computadores explica e pede ao administrador', async ({ page }) => {
    seedGuest(['module:tv']);
    devices.guestLimit = 0;
    devices.openCodes.add('BCDF2345');

    await page.goto('/ajustes/dispositivos?codigo=bcdf2345');
    const sheet = page.getByRole('dialog', { name: 'Aprovar este computador' });
    await sheet.getByLabel('Sua senha').fill(GUEST.password);
    await sheet.getByRole('button', { name: 'Aprovar' }).click();

    await expect(
      sheet.getByText('Peça ao administrador para revogar um.', { exact: false }),
    ).toBeVisible();
    expect(devices.tvs).toEqual([]);
  });

  test('sem o código no endereço o botão abre a folha em branco', async ({ page }) => {
    seedGuest(['module:tv']);
    await page.goto('/ajustes/dispositivos');
    await page.getByRole('button', { name: 'Aprovar este computador' }).click();
    const sheet = page.getByRole('dialog', { name: 'Aprovar este computador' });
    await expect(sheet.getByLabel('Código do computador')).toHaveValue('');
    await expect(sheet.getByRole('button', { name: 'Aprovar' })).toBeDisabled();
    await sheet.getByRole('button', { name: 'Cancelar' }).click();
    await expect(sheet).toHaveCount(0);
    expect(devices.requests).toHaveLength(0);
  });
});

test.describe('aprovar com "Para quem é a TV"', () => {
  test('marca uma pessoa: a TV nasce ligada ao agente, com ela de membro e o nome dela', async ({
    page,
  }, info) => {
    identity.loggedIn = true;
    identity.stepUpValid = true; // a passkey tem teste próprio em devices.spec.ts
    identity.guests.push({
      id: GUEST_ID,
      displayName: 'Raphael',
      email: 'raphael@exemplo.com',
      password: 'x',
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
    });
    devices.openCodes.add('BCDF2345');

    await page.goto('/ajustes/dispositivos?codigo=bcdf2345');
    const sheet = page.getByRole('dialog', { name: 'Parear aparelho' });
    await expect(sheet).toBeVisible();
    const person = sheet.getByRole('switch', { name: 'Raphael' });
    await expect(person).not.toBeChecked();
    await person.check();
    await expectNoHorizontalScroll(page);
    await settle(page);
    await screenshot(page, info.outputPath('pair-for-whom.png'));

    await sheet.getByRole('button', { name: 'Aprovar' }).click();
    await expect(page.getByText('Aparelho PC de casa pareado.')).toBeVisible();

    expect(devices.tvs).toEqual([
      { name: 'TV de Raphael', agentSlug: devices.agents[0].slug, memberIds: [GUEST_ID] },
    ]);
  });

  test('sem ninguém marcado a TV é só do dono', async ({ page }) => {
    identity.loggedIn = true;
    identity.stepUpValid = true;
    devices.openCodes.add('BCDF2345');

    await page.goto('/ajustes/dispositivos?codigo=bcdf2345');
    const sheet = page.getByRole('dialog', { name: 'Parear aparelho' });
    await sheet.getByRole('button', { name: 'Aprovar' }).click();
    await expect(page.getByText('Aparelho PC de casa pareado.')).toBeVisible();

    expect(devices.tvs).toEqual([
      { name: 'PC de casa', agentSlug: devices.agents[0].slug, memberIds: [] },
    ]);
  });
});
