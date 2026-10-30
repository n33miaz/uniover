import { Page, TestInfo } from '@playwright/test';
import { IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { MockTv, TvMock, installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { MockComputer, SystemMock, mockSystemApi } from './system-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

let identity: IdentityMock;
let tv: TvMock;
let system: SystemMock;

const CASA: MockComputer = {
  slug: 'pc-casa',
  name: 'PC de casa',
  platform: 'windows',
  online: true,
  revoked: false,
};
const NOTEBOOK: MockComputer = {
  slug: 'notebook',
  name: 'Notebook',
  platform: 'windows',
  online: false,
  revoked: false,
};

/** A TV de casa, a padrão, controlada pelo computador de casa. */
const TV_CASA: MockTv = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Casa',
  isDefault: true,
  agentSlug: 'pc-casa',
  kind: 'android',
  online: true,
  capabilities: ['tv.remote', 'tv.kind.android', 'tv.adb'],
};

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  tv = await mockTvApi(context, identity);
  // Depois do mock da TV: a rota registrada por último vence, e a configuração mora sob o mesmo prefixo.
  system = await mockSystemApi(context, identity);
  await installFakeEventSource(page);
});

/** Dois computadores pareados; a TV de casa é controlada pelo de casa e o notebook ainda não tem TV. */
function seedPaired(): void {
  tv.tvs = [{ ...TV_CASA }];
  system.computers.push({ ...CASA }, { ...NOTEBOOK });
  system.current = CASA.slug;
  system.source = 'saved';
}

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

/** No Chromium cadastra uma passkey no autenticador virtual (o WebKit do Playwright não tem WebAuthn). */
async function preparePasskey(page: Page, browserName: string) {
  if (browserName !== 'chromium') {
    identity.stepUpValid = true;
    return;
  }
  await addVirtualAuthenticator(page);
  await page.goto('/ajustes/seguranca');
  await page.getByRole('button', { name: 'Cadastrar passkey' }).click();
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByLabel('Nome da passkey (opcional)').fill('Notebook');
  await page.getByRole('button', { name: 'Cadastrar', exact: true }).click();
  await expect(page.getByText('Passkey cadastrada.', { exact: true })).toBeVisible();
}

/** Abre a tela e espera o título; `list` espera também a lista de TVs (que não existe quando não há nenhuma). */
async function open(page: Page, scheme: Scheme = 'light', list = true) {
  // Movimento reduzido: as animações de entrada saem do caminho e o axe mede as cores finais (o executor da CI é lento).
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.goto('/ajustes/sistema');
  await expect(page.getByRole('heading', { level: 1, name: 'Sistema' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'TVs', exact: true })).toBeVisible();
  if (list) await expect(page.locator('ul.tvs')).toBeVisible();
}

const shot = (info: TestInfo, name: string, scheme: Scheme) =>
  `test-results/tv-binding/${name}-${info.project.name}-${scheme}.png`;

/** O roteiro de toda tela: sem rolagem de lado, print, alvos de 44 px e o axe sem nenhuma violação. */
async function check(page: Page, info: TestInfo, name: string, scheme: Scheme) {
  await settle(page);
  await expectNoHorizontalScroll(page);
  await screenshot(page, shot(info, name, scheme), { fullPage: true });
  expect(await smallTargets(page)).toEqual([]);
  await expectNoA11yViolations(page);
}

const row = (page: Page, name: string) =>
  page.locator('ul.tvs button.ui-row', { has: page.getByText(name, { exact: true }) });
const sheet = (page: Page) => page.locator('app-tv-edit-sheet dialog');
const requestsTo = (method: string) => tv.requests.filter((r) => r.method === method);

test.describe('Configurações > Sistema > TVs', () => {
  test('edita o limite pelo app após confirmar com a passkey', async ({ page, browserName }) => {
    seedPaired();
    await preparePasskey(page, browserName);
    await open(page);
    await expect(page.getByLabel('Computadores por Convidado')).toHaveValue('2');
    await expect(page.getByText('do servidor').first()).toBeVisible();
    await page.getByLabel('Computadores por Convidado').fill('4');
    await page.getByRole('button', { name: 'Salvar Dispositivos' }).click();
    if (browserName === 'chromium') {
      const dialog = page.getByRole('dialog', { name: 'Confirmar com passkey' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Confirmar' }).click();
    }
    await expect(page.getByText('Configuração salva.')).toBeVisible();
    await expect(page.getByLabel('Computadores por Convidado')).toHaveValue('4');
    expect(system.settings.find((item) => item.key === 'devices.max-per-guest')).toMatchObject({
      value: 4,
      source: 'app',
    });
  });

  test('o interruptor salva ao alternar, sem botão de salvar ao lado', async ({
    page,
    browserName,
  }) => {
    seedPaired();
    await preparePasskey(page, browserName);
    await open(page);
    await expect(page.getByRole('button', { name: /^Salvar Limpeza/ })).toHaveCount(0);
    await page.getByText('Limpeza Leve Automática').click();
    if (browserName === 'chromium') {
      const dialog = page.getByRole('dialog', { name: 'Confirmar com passkey' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Confirmar' }).click();
    }
    await expect(page.getByText('Configuração salva.')).toBeVisible();
    expect(system.settings.find((item) => item.key === 'tv.light-cleanup-enabled')).toMatchObject({
      value: false,
      source: 'app',
    });
  });

  test('mostra o estado do bucket de fotos e só deixa ligar quando ele está pronto', async ({
    page,
  }) => {
    seedPaired();
    await open(page);
    await expect(page.getByText('Bucket pronto no servidor.')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Fotos na Nuvem' })).toBeEnabled();
  });

  test('sem bucket no servidor, avisa e trava o interruptor de fotos', async ({ page }) => {
    seedPaired();
    system.bucketConfigured = false;
    await open(page);
    await expect(page.getByText(/ainda não configurado no servidor/)).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Fotos na Nuvem' })).toBeDisabled();
  });

  test('a linha Sistema da lista leva à tela', async ({ page }) => {
    seedPaired();
    await page.goto('/ajustes');
    await page.getByRole('link', { name: /^Sistema/ }).click();
    await expect(page).toHaveURL(/\/ajustes\/sistema$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sistema' })).toBeVisible();
    await page.getByRole('button', { name: 'Voltar às Configurações' }).click();
    await expect(page).toHaveURL(/\/ajustes$/);
  });

  for (const scheme of SCHEMES) {
    test(`mostra a TV com o computador e o estado, e a lista dos computadores livres, no tema ${scheme}`, async ({
      page,
    }, info) => {
      seedPaired();
      await open(page, scheme);

      await expect(row(page, 'Casa')).toContainText('PC de casa · Android');
      await expect(row(page, 'Casa').locator('.chip')).toHaveText('Ligado');
      // Só uma ação principal na tela.
      await expect(page.locator('button.primary')).toHaveCount(1);
      await check(page, info, 'system-list', scheme);

      // A folha oferece o computador da TV (já escolhido) e o livre, cada um com o seu estado.
      await row(page, 'Casa').click();
      await expect(sheet(page).locator('.choice .ui-row-title')).toHaveText([
        'PC de casa',
        'Notebook',
      ]);
      await expect(sheet(page).locator('.choice .ui-chip')).toHaveText(['Ligado', 'Desligado']);
      await expect(sheet(page).getByRole('radio', { name: /PC de casa/ })).toBeChecked();
      await expect(sheet(page).getByRole('radio', { name: /Notebook/ })).not.toBeChecked();
      await expect(sheet(page).getByRole('button', { name: 'Salvar' })).toBeDisabled();
    });

    test(`avisa que o computador da TV não foi encontrado quando ele foi revogado, no tema ${scheme}`, async ({
      page,
    }, info) => {
      tv.tvs = [{ ...TV_CASA }];
      system.computers.push({ ...CASA, revoked: true }, { ...NOTEBOOK });
      system.current = CASA.slug;
      system.source = 'saved';
      await open(page, scheme);

      await expect(row(page, 'Casa')).toContainText('Computador não encontrado');
      await expect(row(page, 'Casa').locator('.chip')).toHaveText('Não encontrado');
      await check(page, info, 'system-revoked', scheme);

      // O revogado não está na lista e nada vem escolhido: salvar espera uma escolha.
      await row(page, 'Casa').click();
      await expect(sheet(page).locator('.choice .ui-row-title')).toHaveText(['Notebook']);
      await expect(sheet(page).locator('.choice input')).not.toBeChecked();
      await expect(sheet(page).getByRole('button', { name: 'Salvar' })).toBeDisabled();
    });

    test(`explica o vazio e leva a Aparelhos, no tema ${scheme}`, async ({ page }, info) => {
      tv.tvs = [];
      await open(page, scheme, false);

      await expect(page.getByText('Nenhuma TV ainda.')).toBeVisible();
      await expect(page.getByText('Todo computador pareado já tem uma TV.')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Ir para Dispositivos' })).toHaveAttribute(
        'href',
        '/ajustes/dispositivos',
      );
      await expect(page.getByRole('button', { name: 'Adicionar TV' })).toHaveCount(0);
      await check(page, info, 'system-empty', scheme);
    });

    test(`mostra o erro e deixa tentar de novo, no tema ${scheme}`, async ({ page }, info) => {
      seedPaired();
      system.failReads = 1;
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.goto('/ajustes/sistema');

      await expect(page.getByText('Não foi possível carregar as TVs agora.')).toBeVisible();
      await check(page, info, 'system-error', scheme);

      await page.getByRole('button', { name: 'Tentar de novo' }).click();
      await expect(row(page, 'Casa')).toContainText('PC de casa');
      await expect
        .poll(() => system.requests.filter((r) => r.method === 'GET').length)
        .toBeGreaterThanOrEqual(2);
    });
  }

  test('troca o computador da TV com a passkey e mostra o resultado', async ({
    page,
    browserName,
  }, info) => {
    seedPaired();
    await preparePasskey(page, browserName);
    await open(page);

    await row(page, 'Casa').click();
    await sheet(page)
      .getByRole('radio', { name: /Notebook/ })
      .check();
    await expect(sheet(page).getByRole('button', { name: 'Salvar' })).toBeEnabled();
    await sheet(page).getByRole('button', { name: 'Salvar' }).click();

    if (browserName === 'chromium') {
      const dialog = page.getByRole('dialog', { name: 'Confirmar com passkey' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('ligar um computador à TV');
      await dialog.getByRole('button', { name: 'Confirmar' }).click();
    }

    await expect(sheet(page)).toBeHidden();
    await expect(page.getByText('Pronto: as TVs foram atualizadas.')).toBeVisible();
    await expect(row(page, 'Casa')).toContainText('Notebook');

    // No Chromium o primeiro pedido é recusado (passkey pendente) e repetido uma vez depois da confirmação; só o que
    // mudou vai no corpo (o computador, não o nome).
    expect(requestsTo('PATCH').map((r) => r.body)).toEqual(
      Array(browserName === 'chromium' ? 2 : 1).fill({ agentSlug: 'notebook' }),
    );
    expect(tv.tvs![0].agentSlug).toBe('notebook');
    await check(page, info, 'system-saved', 'light');
  });

  test('salvar sem trocar o computador não toca na TV', async ({ page, browserName }) => {
    seedPaired();
    await preparePasskey(page, browserName);
    await open(page);

    // Só o nome muda: o computador não vai no corpo.
    await row(page, 'Casa').click();
    await sheet(page).getByLabel('Nome').fill('Sala');
    await sheet(page).getByRole('button', { name: 'Salvar' }).click();
    if (browserName === 'chromium') {
      await page
        .getByRole('dialog', { name: 'Confirmar com passkey' })
        .getByRole('button', { name: 'Confirmar' })
        .click();
    }

    await expect(page.getByText('Pronto: as TVs foram atualizadas.')).toBeVisible();
    await expect(row(page, 'Sala')).toContainText('PC de casa');
    expect(requestsTo('PATCH').every((r) => !('agentSlug' in (r.body ?? {})))).toBe(true);
    expect(tv.tvs![0].agentSlug).toBe('pc-casa');
  });

  test('mostra as últimas limpezas e o interruptor de fechar apps, desligado, e o liga com a passkey', async ({
    page,
    browserName,
  }, info) => {
    seedPaired();
    tv.tvs![0].cleanupReports = [
      {
        kind: 'light',
        trigger: 'automatic',
        startedAt: '2026-10-27T11:05:00Z',
        durationMs: 900,
        memoryBeforeMb: 210,
        memoryAfterMb: 290,
        closedApps: 0,
        closedPackages: [],
        backgroundProcesses: 14,
        sessionOpenMs: null,
        result: 'completed',
        reason: null,
      },
      {
        kind: 'deep',
        trigger: 'automatic',
        startedAt: '2026-10-27T10:05:00Z',
        durationMs: 0,
        memoryBeforeMb: null,
        memoryAfterMb: null,
        closedApps: 0,
        closedPackages: [],
        backgroundProcesses: null,
        sessionOpenMs: 11500,
        result: 'skipped',
        reason: 'media-in-use',
      },
    ];
    await preparePasskey(page, browserName);
    await open(page);

    await row(page, 'Casa').click();
    const toggle = sheet(page).getByRole('switch', { name: 'Fechar Apps em Segundo Plano' });
    await expect(toggle).not.toBeChecked();
    await expect(sheet(page).locator('.report .report-outcome')).toHaveText([
      'Liberou 80 MB',
      'Pulada: TV em uso',
    ]);
    await expect(sheet(page).getByRole('button', { name: 'Salvar' })).toBeDisabled();
    await sheet(page).locator('.report').last().scrollIntoViewIfNeeded();
    await settle(page);
    await screenshot(page, shot(info, 'system-cleanup-reports', 'light'));

    await toggle.check();
    await expect(sheet(page).getByRole('button', { name: 'Salvar' })).toBeEnabled();
    await sheet(page).locator('.cleanup-hint').last().scrollIntoViewIfNeeded();
    await settle(page);
    await screenshot(page, shot(info, 'system-cleanup-switch', 'light'));
    await sheet(page).getByRole('button', { name: 'Salvar' }).click();
    if (browserName === 'chromium') {
      await page
        .getByRole('dialog', { name: 'Confirmar com passkey' })
        .getByRole('button', { name: 'Confirmar' })
        .click();
    }

    await expect(page.getByText('Pronto: as TVs foram atualizadas.')).toBeVisible();
    // Só a opção vai no corpo: nome e computador não mudaram.
    expect(
      requestsTo('PATCH').every(
        (r) => Object.keys(r.body ?? {}).join() === 'allowBackgroundAppClosing',
      ),
    ).toBe(true);
    expect(tv.tvs![0].allowBackgroundAppClosing).toBe(true);
  });

  test('cancelar a passkey não troca nada', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'a passkey virtual só existe no Chromium');
    seedPaired();
    await preparePasskey(page, browserName);
    await open(page);

    await row(page, 'Casa').click();
    await sheet(page)
      .getByRole('radio', { name: /Notebook/ })
      .check();
    await sheet(page).getByRole('button', { name: 'Salvar' }).click();
    await page
      .getByRole('dialog', { name: 'Confirmar com passkey' })
      .getByRole('button', { name: 'Cancelar' })
      .click();

    await expect(
      sheet(page).getByText('A mudança não foi confirmada com a passkey. Nada foi alterado.'),
    ).toBeVisible();
    expect(requestsTo('PATCH')).toHaveLength(1);
    expect(tv.tvs![0].agentSlug).toBe('pc-casa');
    await sheet(page).getByRole('button', { name: 'Cancelar' }).click();
    await expect(sheet(page)).toBeHidden();
    await expect(row(page, 'Casa')).toContainText('PC de casa');
  });

  test('se o computador já foi tomado por outra TV no meio, a folha avisa e nada é trocado', async ({
    page,
    browserName,
  }) => {
    seedPaired();
    await preparePasskey(page, browserName);
    await open(page);

    await row(page, 'Casa').click();
    await sheet(page)
      .getByRole('radio', { name: /Notebook/ })
      .check();
    // Outra TV passa a usar o Notebook antes de salvar: o servidor recusa com 409.
    tv.tvs!.push({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Quarto',
      isDefault: false,
      agentSlug: 'notebook',
      kind: null,
      online: false,
      capabilities: [],
    });
    identity.stepUpValid = true;
    await sheet(page).getByRole('button', { name: 'Salvar' }).click();

    await expect(
      sheet(page).getByText('Esse computador já controla outra TV. Escolha outro.'),
    ).toBeVisible();
    expect(tv.tvs![0].agentSlug).toBe('pc-casa');
  });
});
