import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';
import { IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { settle } from '../screens/screen-helpers';
import {
  DEFAULT_LOG,
  DevicesMock,
  NEWER_SHA,
  PREVIOUS_SHA,
  RATE_LIMITED_CODE,
  mockDevicesApi,
  storedAgent,
  storedUpdate,
} from './devices-mock';

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

/** Entra, (no Chromium) cadastra uma passkey no autenticador virtual e abre Configurações > Dispositivos. */
async function openDevices(page: Page, browserName: string, expandMaintenance = true) {
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
  await page.getByRole('link', { name: /^Dispositivos/ }).click();
  await expect(page).toHaveURL(/\/ajustes\/dispositivos$/);
  await expect(page.getByRole('heading', { level: 2, name: 'Computadores' })).toBeVisible();
  if (!expandMaintenance) return;
  // A manutenção de cada computador vem dobrada; abre as dobras para alcançar as ações.
  await page.locator('.item, .empty').first().waitFor();
  await expect(async () => {
    await page.locator('details.maintenance').evaluateAll((all) => {
      for (const details of all as HTMLDetailsElement[]) details.open = true;
    });
    await expect(page.locator('details.maintenance:not([open])')).toHaveCount(0, { timeout: 500 });
  }).toPass();
}

async function typeCode(page: Page, code: string) {
  await page.getByLabel('Código do dispositivo').fill(code);
}

function seriousViolations(violations: { id: string; impact?: string | null }[]) {
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => v.id);
}

test.describe('dispositivos', () => {
  test('mostra o vazio explicativo e cabe na tela', async ({ page, browserName }, info) => {
    await openDevices(page, browserName);
    await expect(page.getByText('Nenhum dispositivo pareado.')).toBeVisible();
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

    await page.getByRole('button', { name: 'Parear dispositivo' }).click();
    const sheet = page.getByRole('dialog', { name: 'Parear dispositivo' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: /fechar|close/i })).toHaveCount(0);
    const code = sheet.getByLabel('Código do dispositivo');
    await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    await expect(sheet.getByLabel('Nome do dispositivo')).toHaveValue('PC de casa');
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

    await expect(page.getByText('Dispositivo PC de casa pareado.')).toBeVisible();
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

  test('pergunta como chamar a TV, curto, e manda o apelido junto do pareamento', async ({
    page,
    browserName,
  }, info) => {
    devices.openCodes.add('BCDF2345');
    await openDevices(page, browserName);
    if (browserName !== 'chromium') identity.stepUpValid = true;

    await page.getByRole('button', { name: 'Parear dispositivo' }).click();
    const sheet = page.getByRole('dialog', { name: 'Parear dispositivo' });
    const nickname = sheet.getByLabel('Como Chamar Esta TV?');
    await expect(nickname).toHaveValue('');
    await expect(nickname).toHaveAttribute('placeholder', 'TV');
    await expect(nickname).toHaveAttribute('maxlength', '20');

    await sheet.getByLabel('Código do dispositivo').fill('bcdf2345');
    await nickname.fill('#sala');
    await expect(sheet.getByRole('button', { name: 'Aprovar' })).toBeDisabled();
    await nickname.fill('Sala');
    await expect(sheet.getByRole('button', { name: 'Aprovar' })).toBeEnabled();
    await expectNoHorizontalScroll(page);
    await settle(page);
    await screenshot(
      page,
      `${process.env['TV_ADMIN_SHOTS'] ?? 'test-results'}/tv-admin-cadastro-apelido-${info.project.name}.png`,
    );

    await sheet.getByRole('button', { name: 'Aprovar' }).click();
    if (browserName === 'chromium') {
      const dialog = page.getByRole('dialog', { name: 'Confirmar com passkey' });
      await dialog.getByRole('button', { name: 'Confirmar' }).click();
    }
    await expect(page.getByText('Dispositivo PC de casa pareado.')).toBeVisible();

    const approvals = devices.requests.filter((r) => r.path === '/pairing/approve');
    expect(approvals.at(-1)?.body).toEqual({
      userCode: 'BCDF2345',
      name: 'PC de casa',
      tvName: 'Sala',
      tvMemberIds: [],
    });
  });

  test('cancelar a passkey não pareia nem repete o pedido', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'a passkey virtual só existe no Chromium');
    devices.openCodes.add('BCDF2345');
    await openDevices(page, browserName);

    await page.getByRole('button', { name: 'Parear dispositivo' }).click();
    const sheet = page.getByRole('dialog', { name: 'Parear dispositivo' });
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
    await page.getByRole('button', { name: 'Parear dispositivo' }).click();
    const sheet = page.getByRole('dialog', { name: 'Parear dispositivo' });

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
    const opener = page.getByRole('button', { name: 'Parear dispositivo' });
    await opener.focus(); // o WebKit não dá foco ao botão no toque; pelo teclado há para onde voltar
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Parear dispositivo' });
    await expect(sheet).toBeVisible();

    await sheet.getByRole('heading', { name: 'Parear dispositivo' }).click();
    await expect(sheet).toBeVisible(); // toque dentro da folha não fecha
    await page.mouse.click(4, 4); // fora do retângulo da folha
    await expect(sheet).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(devices.requests.some((r) => r.path === '/pairing/approve')).toBe(false);
  });

  test('recusa um código sem pedir a passkey', async ({ page, browserName }) => {
    devices.openCodes.add('BCDF2345');
    await openDevices(page, browserName);
    await page.getByRole('button', { name: 'Parear dispositivo' }).click();
    const sheet = page.getByRole('dialog', { name: 'Parear dispositivo' });
    await typeCode(page, 'bcdf2345');
    await sheet.getByRole('button', { name: 'Recusar código' }).click();

    await expect(page.getByText('Código recusado. Nenhum dispositivo foi pareado.')).toBeVisible();
    await expect(sheet).toHaveCount(0);
    expect(devices.requests.filter((r) => r.path === '/pairing/deny')).toHaveLength(1);
    expect(devices.requests.some((r) => r.path === '/pairing/approve')).toBe(false);
    expect(identity.requests.some((r) => r.path.startsWith('/step-up'))).toBe(false);
    expect(devices.openCodes.size).toBe(0);
  });

  test('revoga sem passkey, com confirmação em linha', async ({ page, browserName }) => {
    devices.agents.push(storedAgent());
    await openDevices(page, browserName);
    await expect(page.locator('.item .name')).toHaveText(['PC de casa']);
    await expect(page.locator('.item .last-seen')).toContainText(/Visto (agora|há)/);

    await page.getByRole('button', { name: 'Revogar PC de casa' }).click();
    await expect(
      page.getByText('Revogar o PC de casa? Ele para de receber comandos na hora.'),
    ).toBeVisible();
    expect(devices.requests.some((r) => r.path.endsWith('/revoke'))).toBe(false);
    await page.getByRole('button', { name: 'Revogar', exact: true }).click();

    await expect(page.getByText('Dispositivo revogado.')).toBeVisible();
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
    devices.agents.push(storedAgent());
    await openDevices(page, browserName);
    await expect(page.getByRole('button', { name: 'Parear dispositivo' })).toBeEnabled();

    await context.setOffline(true);
    await expect(page.getByRole('button', { name: 'Parear dispositivo' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Revogar PC de casa' })).toBeDisabled();
    await expect(page.getByText('Sem conexão: isto precisa de rede.')).toBeVisible();

    await context.setOffline(false);
    await expect(page.getByRole('button', { name: 'Parear dispositivo' })).toBeEnabled();
  });

  test('mostra versão, sistema, TV e conexão de cada dispositivo', async ({
    page,
    browserName,
  }, info) => {
    devices.agents.push(
      storedAgent(),
      storedAgent({
        id: '00000000-0000-4000-8000-000000000002',
        slug: 'agent:notebook-antigo',
        name: 'Notebook antigo',
        connected: false,
        agentVersion: null,
        agentBuild: null,
        os: null,
        tvKind: null,
        tvHost: null,
        canReadLogs: false,
        canMaintain: false,
      }),
    );
    await openDevices(page, browserName, false);
    const first = page.locator('.item').first();
    // A manutenção começa dobrada: o estado do computador cabe numa olhada.
    await expect(first.locator('details.maintenance')).not.toHaveAttribute('open', '');
    await expect(first.locator('.version')).toHaveText('Versão 0.1.0 · 3f2a9c1');
    await expect(first).toContainText('Sistema: Windows 11 (10.0.26200)');
    await expect(first.locator('.tv')).toHaveText('Android TV · 192.168.0.20');
    await expect(first.locator('.connection')).toHaveText('Conectado agora');
    await expect(first.locator('.last-seen')).toContainText(/Visto (agora|há)/);
    const second = page.locator('.item').nth(1);
    await expect(second.locator('.connection')).toHaveText('Desconectado');
    await expect(second.locator('.version')).toHaveCount(0);
    // Desconectado: não há a quem pedir registro, atualização ou reinício.
    await expect(second.locator('button.view-log')).toBeDisabled();
    await expect(second.locator('button.revoke')).toBeEnabled();
    await expectNoHorizontalScroll(page);
    await settle(page);
    await screenshot(page, info.outputPath('devices-info.png'));
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(seriousViolations(violations)).toEqual([]);
  });

  test('mostra o estado da atualização: em dia, pendente, falha, voltou e agente antigo', async ({
    page,
    browserName,
  }, info) => {
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    devices.agents.push(
      storedAgent({ update: storedUpdate() }),
      storedAgent({
        id: id(2),
        slug: 'agent:pendente',
        name: 'PC pendente',
        update: storedUpdate({ state: 'pending', latestSha: NEWER_SHA }),
      }),
      storedAgent({
        id: id(3),
        slug: 'agent:falhou',
        name: 'PC que falhou',
        update: storedUpdate({
          state: 'failed',
          latestSha: NEWER_SHA,
          reason: 'não consegui baixar o pacote (ConnectError)',
        }),
      }),
      storedAgent({
        id: id(4),
        slug: 'agent:voltou',
        name: 'PC que voltou',
        update: storedUpdate({
          state: 'blocked',
          latestSha: NEWER_SHA,
          blockedSha: NEWER_SHA,
          rolledBack: true,
        }),
      }),
      storedAgent({
        id: id(5),
        slug: 'agent:antigo',
        name: 'PC com agente antigo',
        agentBuild: null,
        canReadLogs: false,
        canMaintain: false,
        update: null,
      }),
    );
    await openDevices(page, browserName);

    const state = (n: number) => page.locator('.item').nth(n).locator('.update-state');
    await expect(state(0)).toHaveText('Atualizado');
    await expect(page.locator('.item').nth(0).locator('.update-installed')).toContainText(
      'Instalada: 3f2a9c1',
    );
    await expect(page.locator('.item').nth(0).locator('.update-newest')).toContainText(
      'a mesma instalada',
    );
    await expect(state(1)).toContainText('Atualização pendente: próxima checagem em');
    await expect(page.locator('.item').nth(1).locator('.update-newest')).toContainText('a1b2c3d');
    await expect(state(2)).toContainText('Falhou: não consegui baixar o pacote (ConnectError)');
    await expect(page.locator('.item').nth(2).locator('.update-check')).toContainText('falhou');
    await expect(state(3)).toContainText('bloqueada');
    await expect(page.locator('.item').nth(3).locator('.update-rollback')).toContainText(
      'não será instalada de novo',
    );
    await expect(state(4)).toHaveText('Versão desconhecida: atualize o agente');
    await expect(page.locator('.item').nth(4).locator('.update-installed')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await screenshot(page, info.outputPath('devices-update-state.png'), { fullPage: true });
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(seriousViolations(violations)).toEqual([]);
  });

  test('ver registro: folha com o texto monoespaçado, rolagem, copiar e atualizar', async ({
    page,
    browserName,
  }, info) => {
    // O papel de transferência de teste é um dublê: igual nos dois navegadores, sem pedir permissão.
    await page.addInitScript(() => {
      (window as unknown as { copied: string[] }).copied = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string) => {
            (window as unknown as { copied: string[] }).copied.push(text);
            return Promise.resolve();
          },
        },
      });
    });
    devices.agents.push(storedAgent());
    await openDevices(page, browserName);

    await page.getByRole('button', { name: 'Ver registro de PC de casa' }).click();
    const sheet = page.getByRole('dialog', { name: 'Registro de PC de casa' });
    await expect(sheet).toBeVisible();
    const output = sheet.getByLabel('Registro do agente');
    await expect(output).toContainText('linha 120 do registro');
    await expect(sheet).toContainText('120 linhas, as mais recentes.');
    // Começa no fim: a última linha está à vista e a primeira, rolada para cima.
    await expect
      .poll(() => output.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2))
      .toBe(true);
    expect(
      await output.evaluate((el) => getComputedStyle(el).fontFamily.toLowerCase().includes('mono')),
    ).toBe(true);
    // Linhas compridas rolam dentro do bloco: a página não ganha rolagem lateral.
    expect(await output.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await screenshot(page, info.outputPath('devices-log-sheet.png'));
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(seriousViolations(violations)).toEqual([]);

    await sheet.getByRole('button', { name: 'Copiar' }).click();
    await expect(sheet.getByText('Copiado.')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([
      DEFAULT_LOG,
    ]);

    devices.log = { text: 'só esta linha', truncated: true };
    await sheet.getByRole('button', { name: 'Atualizar' }).click();
    await expect(output).toHaveText('só esta linha');
    await expect(sheet).toContainText('Só o fim coube no limite do canal.');
    expect(devices.requests.filter((r) => r.path.endsWith('/logs'))).toHaveLength(2);
    expect(devices.requests.find((r) => r.path.endsWith('/logs'))?.body).toEqual({ lines: 300 });

    await sheet.getByRole('button', { name: 'Fechar' }).click();
    await expect(sheet).toHaveCount(0);
    // Ver o registro não pede passkey.
    expect(identity.requests.some((r) => r.path.startsWith('/step-up'))).toBe(false);
  });

  test('ver registro de um agente antigo manda atualizar o agente', async ({
    page,
    browserName,
  }, info) => {
    devices.agents.push(storedAgent({ canReadLogs: false, canMaintain: false }));
    await openDevices(page, browserName);

    await page.getByRole('button', { name: 'Ver registro de PC de casa' }).click();
    await expect(page.getByText(/Atualize o agente: ele se atualiza sozinho/)).toBeVisible();
    await expect(page.getByRole('dialog', { name: /Registro de/ })).toHaveCount(0);
    // A lista já sabia: nenhum pedido foi gasto à toa.
    expect(devices.requests.some((r) => r.path.endsWith('/logs'))).toBe(false);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await screenshot(page, info.outputPath('devices-log-outdated.png'));
  });

  test('o registro explica um agente que não respondeu', async ({ page, browserName }) => {
    devices.agents.push(storedAgent());
    devices.log = { problem: { status: 504, kind: 'agent-timeout' } };
    await openDevices(page, browserName);

    await page.getByRole('button', { name: 'Ver registro de PC de casa' }).click();
    const sheet = page.getByRole('dialog', { name: 'Registro de PC de casa' });
    await expect(sheet.getByRole('alert')).toContainText('O agente não respondeu a tempo.');
    await expect(sheet.getByRole('button', { name: 'Copiar' })).toBeDisabled();
    devices.log = { text: 'voltou' };
    await sheet.getByRole('button', { name: 'Atualizar' }).click();
    await expect(sheet.getByLabel('Registro do agente')).toHaveText('voltou');
  });

  for (const [action, label, question, done] of [
    [
      'update',
      'Atualizar agora: PC de casa',
      'Atualizar o agente de PC de casa agora? Se houver versão nova, ele reinicia sozinho em até 15 segundos.',
      'Pedido de atualização enviado.',
    ],
    [
      'restart',
      'Reiniciar o agente de PC de casa',
      'Reiniciar o agente de PC de casa? Ele sai do ar por alguns segundos e volta sozinho.',
      'Pedido de reinício enviado.',
    ],
    [
      'rollback',
      'Voltar para a versão anterior de PC de casa',
      'Voltar o agente de PC de casa para a versão anterior (0a1b2c3)? A versão de agora fica bloqueada e ele reinicia sozinho em até 15 segundos.',
      'Pedido enviado. O agente volta para a versão anterior',
    ],
  ] as const) {
    test(`${label}: confirma na tela, pede a passkey e avisa o agente`, async ({
      page,
      browserName,
    }, info) => {
      devices.agents.push(
        storedAgent({
          canRollback: true,
          update: storedUpdate({ previousSha: PREVIOUS_SHA }),
        }),
      );
      await openDevices(page, browserName);
      // No WebKit não há autenticador virtual: só o passo da passkey é pulado (a confirmação já vale).
      if (browserName !== 'chromium') identity.stepUpValid = true;

      await page.getByRole('button', { name: label }).click();
      await expect(page.getByText(question)).toBeVisible();
      expect(devices.requests.some((r) => r.path.endsWith('/maintenance'))).toBe(false);
      await expectNoHorizontalScroll(page);
      await settle(page);
      await screenshot(page, info.outputPath(`devices-${action}-confirm.png`));

      await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
      if (browserName === 'chromium') {
        const dialog = page.getByRole('dialog', { name: 'Confirmar com passkey' });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('atualizar ou reiniciar um computador à distância');
        await dialog.getByRole('button', { name: 'Confirmar' }).click();
      }

      await expect(page.getByText(done)).toBeVisible();
      const calls = devices.requests.filter((r) => r.path.endsWith('/maintenance'));
      // No Chromium o primeiro pedido volta 403 e o segundo, depois da passkey, é aceito.
      expect(calls.map((r) => r.body)).toEqual(
        Array(browserName === 'chromium' ? 2 : 1).fill({ action }),
      );
      await expect(page.getByText(question)).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      // O aviso entra com animação: o contraste só vale depois que ela assenta.
      await settle(page);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(seriousViolations(violations)).toEqual([]);
    });
  }

  test('cancelar a passkey não atualiza nem reinicia nada', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'a passkey virtual só existe no Chromium');
    devices.agents.push(storedAgent());
    await openDevices(page, browserName);

    await page.getByRole('button', { name: 'Reiniciar o agente de PC de casa' }).click();
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirmar com passkey' });
    await dialog.getByRole('button', { name: 'Cancelar' }).click();

    await expect(
      page.getByText('A ação não foi confirmada com a passkey. Nada foi feito.'),
    ).toBeVisible();
    expect(devices.requests.filter((r) => r.path.endsWith('/maintenance'))).toHaveLength(1);
    expect(identity.requests.some((r) => r.path === '/step-up/complete')).toBe(false);
  });

  test('cancelar a confirmação em linha não pede passkey nem manda nada', async ({
    page,
    browserName,
  }) => {
    devices.agents.push(storedAgent());
    await openDevices(page, browserName);

    await page.getByRole('button', { name: 'Atualizar agora: PC de casa' }).click();
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Atualizar agora: PC de casa' })).toBeVisible();
    expect(devices.requests.some((r) => r.path.endsWith('/maintenance'))).toBe(false);
    expect(identity.requests.some((r) => r.path.startsWith('/step-up'))).toBe(false);
  });

  test('o agente offline na hora do pedido: a tela explica sem travar', async ({
    page,
    browserName,
  }) => {
    devices.agents.push(storedAgent());
    devices.maintenanceProblem = { status: 503, kind: 'agent-offline' };
    await openDevices(page, browserName);
    if (browserName !== 'chromium') identity.stepUpValid = true;

    await page.getByRole('button', { name: 'Reiniciar o agente de PC de casa' }).click();
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    if (browserName === 'chromium') {
      await page
        .getByRole('dialog', { name: 'Confirmar com passkey' })
        .getByRole('button', { name: 'Confirmar' })
        .click();
    }
    await expect(
      page.getByText('O agente está desconectado. Ligue o PC e tente de novo.'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Reiniciar o agente de PC de casa' }),
    ).toBeVisible();
  });
});
