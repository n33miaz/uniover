import { Page, TestInfo } from '@playwright/test';
import { IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { MockComputer, SystemMock, mockSystemApi } from './system-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

let identity: IdentityMock;
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

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  await mockTvApi(context, identity);
  // Depois do mock da TV: a rota registrada por último vence, e a configuração mora sob o mesmo prefixo.
  system = await mockSystemApi(context, identity);
  await installFakeEventSource(page);
});

/** Dois computadores pareados; o de casa controla a TV, escolha que ainda vem só do servidor. */
function seedPaired(): void {
  system.computers.push({ ...CASA }, { ...NOTEBOOK });
  system.current = CASA.slug;
  system.source = 'environment';
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

async function open(page: Page, scheme: Scheme = 'light') {
  // Movimento reduzido: as animações de entrada saem do caminho e o axe mede as cores finais (o executor da CI é lento).
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.goto('/ajustes/sistema');
  await expect(page.getByRole('heading', { level: 1, name: 'Sistema' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'TV', exact: true })).toBeVisible();
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

const requestsTo = (method: string) => system.requests.filter((r) => r.method === method);

test.describe('Ajustes > Sistema > TV', () => {
  test('a linha Sistema da lista leva à tela', async ({ page }) => {
    seedPaired();
    await page.goto('/ajustes');
    await page.getByRole('link', { name: /^Sistema/ }).click();
    await expect(page).toHaveURL(/\/ajustes\/sistema$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sistema' })).toBeVisible();
    await page.getByRole('link', { name: 'Voltar aos Ajustes' }).click();
    await expect(page).toHaveURL(/\/ajustes$/);
  });

  for (const scheme of SCHEMES) {
    test(`mostra o computador, de onde vem a escolha e a lista, no tema ${scheme}`, async ({
      page,
    }, info) => {
      seedPaired();
      await open(page, scheme);

      await expect(page.locator('.current .name')).toHaveText('PC de casa');
      await expect(page.locator('.current .chip')).toHaveText('Ligado');
      await expect(
        page.getByText(
          'Vem da configuração do servidor. Salve aqui para guardar a escolha no app.',
        ),
      ).toBeVisible();
      await expect(page.locator('.choice .ui-row-title')).toHaveText(['PC de casa', 'Notebook']);
      await expect(page.locator('.choice .chip')).toHaveText(['Ligado', 'Desligado']);
      await expect(page.locator('.choice input').first()).toBeChecked();
      await expect(page.locator('.warning')).toHaveCount(0);
      // Só uma ação principal na tela.
      await expect(page.locator('button.primary')).toHaveCount(1);
      await check(page, info, 'system-list', scheme);
    });

    test(`avisa que a TV não responde quando o computador foi revogado, no tema ${scheme}`, async ({
      page,
    }, info) => {
      system.computers.push({ ...CASA, revoked: true }, { ...NOTEBOOK });
      system.current = CASA.slug;
      system.source = 'saved';
      await open(page, scheme);

      await expect(page.locator('.current .chip')).toHaveText('Revogado');
      await expect(page.locator('.warning')).toContainText(
        'A TV não vai responder até você escolher outro computador ou parear de novo em Aparelhos.',
      );
      // O revogado não está na lista e nada vem escolhido: salvar espera uma escolha.
      await expect(page.locator('.choice .ui-row-title')).toHaveText(['Notebook']);
      await expect(page.locator('.choice input')).not.toBeChecked();
      await expect(page.getByRole('button', { name: 'Salvar' })).toBeDisabled();
      await check(page, info, 'system-revoked', scheme);
    });

    test(`explica o vazio e leva a Aparelhos, no tema ${scheme}`, async ({ page }, info) => {
      await open(page, scheme);

      await expect(
        page.getByText('Nenhum computador pareado. Pareie o computador de casa em Aparelhos', {
          exact: false,
        }),
      ).toBeVisible();
      await expect(page.locator('.current .name')).toHaveText('Nenhum computador escolhido');
      await expect(page.getByRole('link', { name: 'Ir para Aparelhos' })).toHaveAttribute(
        'href',
        '/ajustes/aparelhos',
      );
      await expect(page.getByRole('button', { name: 'Salvar' })).toHaveCount(0);
      await check(page, info, 'system-empty', scheme);
    });

    test(`mostra o erro e deixa tentar de novo, no tema ${scheme}`, async ({ page }, info) => {
      seedPaired();
      system.failReads = 1;
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.goto('/ajustes/sistema');

      await expect(
        page.getByText('Não foi possível carregar a configuração da TV agora.'),
      ).toBeVisible();
      await check(page, info, 'system-error', scheme);

      await page.getByRole('button', { name: 'Tentar de novo' }).click();
      await expect(page.locator('.current .name')).toHaveText('PC de casa');
      await expect.poll(() => requestsTo('GET').length).toBeGreaterThanOrEqual(2);
    });
  }

  test('troca o computador com a passkey e mostra o resultado', async ({
    page,
    browserName,
  }, info) => {
    seedPaired();
    await preparePasskey(page, browserName);
    await open(page);

    await page.locator('.choice', { hasText: 'Notebook' }).click();
    await expect(page.getByRole('button', { name: 'Salvar' })).toBeEnabled();
    await page.getByRole('button', { name: 'Salvar' }).click();

    if (browserName === 'chromium') {
      const dialog = page.getByRole('dialog', { name: 'Confirmar com passkey' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('trocar o computador que controla a TV');
      await dialog.getByRole('button', { name: 'Confirmar' }).click();
    }

    await expect(page.getByText('Pronto: agora Notebook controla a TV.')).toBeVisible();
    await expect(page.locator('.current .name')).toHaveText('Notebook');
    await expect(page.locator('.current .chip')).toHaveText('Desligado');
    await expect(page.getByText('Escolhido aqui, no app.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Salvar' })).toBeDisabled();

    // No Chromium o primeiro pedido é recusado (passkey pendente) e repetido uma vez depois da confirmação.
    const puts = requestsTo('PUT');
    expect(puts.map((r) => r.body)).toEqual(
      Array(browserName === 'chromium' ? 2 : 1).fill({ agentSlug: 'notebook', name: null }),
    );
    expect(system.current).toBe('notebook');
    expect(system.source).toBe('saved');
    await check(page, info, 'system-saved', 'light');
  });

  test('salvar o computador que já vem do servidor o guarda no app', async ({
    page,
    browserName,
  }) => {
    seedPaired();
    await preparePasskey(page, browserName);
    await open(page);

    await expect(page.getByRole('button', { name: 'Salvar' })).toBeEnabled();
    await page.getByRole('button', { name: 'Salvar' }).click();
    if (browserName === 'chromium') {
      await page
        .getByRole('dialog', { name: 'Confirmar com passkey' })
        .getByRole('button', { name: 'Confirmar' })
        .click();
    }

    await expect(page.getByText('Pronto: agora PC de casa controla a TV.')).toBeVisible();
    await expect(page.getByText('Escolhido aqui, no app.')).toBeVisible();
    expect(system.source).toBe('saved');
    expect(system.current).toBe('pc-casa');
  });

  test('cancelar a passkey não troca nada', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'a passkey virtual só existe no Chromium');
    seedPaired();
    await preparePasskey(page, browserName);
    await open(page);

    await page.locator('.choice', { hasText: 'Notebook' }).click();
    await page.getByRole('button', { name: 'Salvar' }).click();
    await page
      .getByRole('dialog', { name: 'Confirmar com passkey' })
      .getByRole('button', { name: 'Cancelar' })
      .click();

    await expect(page.getByText('A troca não foi feita', { exact: false })).toBeVisible();
    await expect(page.locator('.current .name')).toHaveText('PC de casa');
    expect(requestsTo('PUT')).toHaveLength(1);
    expect(system.current).toBe('pc-casa');
    expect(system.source).toBe('environment');
  });

  test('se o computador sai da lista no meio, a lista é atualizada e nada é trocado', async ({
    page,
    browserName,
  }) => {
    seedPaired();
    await preparePasskey(page, browserName);
    await open(page);

    await page.locator('.choice', { hasText: 'Notebook' }).click();
    // Outra pessoa revoga o Notebook antes de salvar: o servidor recusa e a tela mostra a lista de agora.
    system.computers.find((c) => c.slug === 'notebook')!.revoked = true;
    identity.stepUpValid = true;
    await page.getByRole('button', { name: 'Salvar' }).click();

    await expect(
      page.getByText('Esse computador não está mais na lista de pareados', { exact: false }),
    ).toBeVisible();
    await expect(page.locator('.choice .ui-row-title')).toHaveText(['PC de casa']);
    expect(system.current).toBe('pc-casa');
  });
});
