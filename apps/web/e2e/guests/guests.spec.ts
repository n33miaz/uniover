import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';
import { GUEST, IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import {
  HOT_STATE,
  SHORTCUTS,
  TvMock,
  emitSse,
  installFakeEventSource,
  mockTvApi,
  sseUrls,
} from '../tv/tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

let identity: IdentityMock;
let tv: TvMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  tv = await mockTvApi(context, identity);
  await installFakeEventSource(page);
});

async function expectNoSeriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

async function signInAsOwner(page: Page) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
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

/** O controle da TV para quem acabou de entrar: entrega o instantâneo que a API manda ao abrir o fluxo. */
async function showTv(page: Page) {
  await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
  await emitSse(page, 'tv.state', HOT_STATE);
  await emitSse(page, 'tv.shortcuts', tv.shortcuts);
  await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
}

async function acceptInvite(page: Page, token: string) {
  await page.goto(`/convite#${token}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Criar sua conta' })).toBeVisible();
  await page.getByLabel('E-mail').fill(GUEST.email);
  await page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
  await page.getByLabel('Repita a senha').fill(GUEST.password);
  await page.getByRole('button', { name: 'Criar conta e entrar' }).click();
}

test.describe('convite do dono (passkey)', () => {
  test.beforeEach(({ browserName }) => {
    // O autenticador virtual vem do protocolo do Chromium; no WebKit a verificação é no aparelho.
    test.skip(browserName !== 'chromium', 'autenticador virtual só existe no Chromium');
  });

  test('o dono gera o link com a passkey, vê o convite pendente e o revoga', async ({
    page,
  }, info) => {
    await addVirtualAuthenticator(page);
    await signInAsOwner(page);
    await page.goto('/ajustes');

    // Sem passkey cadastrada não há como confirmar: cadastra uma, como o dono faz em Segurança.
    await page.getByRole('button', { name: 'Cadastrar passkey' }).click();
    await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
    await page.getByLabel('Nome da passkey (opcional)').fill('Notebook');
    await page.getByRole('button', { name: 'Cadastrar', exact: true }).click();
    await expect(page.getByText('Passkey cadastrada.')).toBeVisible();

    await expect(page.getByRole('heading', { level: 2, name: 'Convidados' })).toBeVisible();
    await expect(page.getByText('Nenhum convite pendente.')).toBeVisible();
    await page.getByLabel('Nome do convidado').fill(GUEST.displayName);
    await page.getByRole('button', { name: 'Gerar convite' }).click();

    // Conceder acesso pede a confirmação com a passkey, e só depois o pedido é repetido.
    const dialog = page.getByRole('dialog', { name: 'Confirmar com passkey' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('criar um convite de convidado');
    await dialog.getByRole('button', { name: 'Confirmar' }).click();

    const link = page.getByLabel('Link do convite');
    await expect(link).toBeVisible();
    const url = await link.inputValue();
    expect(url).toMatch(/\/convite#[A-Za-z0-9_-]{43}$/);
    expect(identity.invites).toHaveLength(1);
    expect(url.endsWith(`#${identity.invites[0].token}`)).toBe(true);
    await expect(page.getByText('serve uma vez só')).toBeVisible();

    const order = identity.requests.map((r) => `${r.method} ${r.path}`);
    expect(order.indexOf('POST /step-up/complete')).toBeGreaterThan(
      order.indexOf('POST /guest-invites'),
    );
    expect(
      identity.requests.filter((r) => r.path === '/guest-invites' && r.method === 'POST'),
    ).toHaveLength(2);

    // O dono vê o pendente na lista (sem segredo) e o revoga.
    await expect(page.locator('app-guests-section .item .name')).toHaveText([GUEST.displayName]);
    await screenshot(page, `test-results/guests-owner-${info.project.name}.png`);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectNoSeriousViolations(page);
    }
    await expectNoHorizontalScroll(page);

    await page.getByRole('button', { name: `Revogar o convite de ${GUEST.displayName}` }).click();
    await page.getByRole('button', { name: 'Revogar', exact: true }).click();
    await expect(page.getByText('Convite revogado.')).toBeVisible();
    await expect(page.getByText('Nenhum convite pendente.')).toBeVisible();
    expect(identity.invites[0].status).toBe('revoked');
  });
});

test.describe('convidado: só o controle da TV', () => {
  test('aceita o convite, define a própria senha e cai direto no controle, sem Início nem voltar', async ({
    page,
  }, info) => {
    // Além dos três do controle, um app instalado que o dono não fixou (o convidado o abre) e um que saiu da TV (não aparece).
    const outOfControl = {
      ...SHORTCUTS[0],
      id: '00000000-0000-4000-8000-000000000004',
      position: 4,
      package: 'exemplo.pacote.app4',
      enabled: false,
    };
    const gone = {
      ...outOfControl,
      id: '00000000-0000-4000-8000-000000000005',
      position: 5,
      package: 'exemplo.pacote.app5',
      installed: false,
    };
    tv.shortcuts = [...SHORTCUTS, outOfControl, gone];
    const invite = identity.seedInvite();
    await page.goto(`/convite#${invite.token}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Criar sua conta' })).toBeVisible();

    // O segredo sai do endereço assim que a tela o lê, e nunca aparece na tela.
    await expect(page).toHaveURL(/\/convite$/);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(invite.token);
    await expect(page.getByText('Não existe recuperação de senha')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await screenshot(page, `test-results/guests-accept-${info.project.name}.png`);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectNoSeriousViolations(page);
    }

    // Senhas diferentes e senha curta são barradas antes de ir ao servidor.
    await page.getByLabel('E-mail').fill(GUEST.email);
    await page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
    await page.getByLabel('Repita a senha').fill('outra-senha-longa-demais');
    await page.getByRole('button', { name: 'Criar conta e entrar' }).click();
    await expect(page.getByRole('alert')).toContainText('As duas senhas não são iguais.');
    await page.getByLabel('Senha', { exact: true }).fill('curta');
    await page.getByLabel('Repita a senha').fill('curta');
    await page.getByRole('button', { name: 'Criar conta e entrar' }).click();
    await expect(page.getByRole('alert')).toContainText('ao menos 10 caracteres');
    expect(identity.requests.some((r) => r.path === '/guest-invites/accept')).toBe(false);

    await page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
    await page.getByLabel('Repita a senha').fill(GUEST.password);
    await page.getByRole('button', { name: 'Criar conta e entrar' }).click();

    // Visão única: cai no controle, sem Início, sem voltar, sem abas.
    await expect(page).toHaveURL(/\/tv$/);
    await showTv(page);
    await expect(page.getByRole('link', { name: /Início/ })).toHaveCount(0);
    await expect(page.getByText('Início', { exact: true })).toHaveCount(0);
    await expect(page.locator('a[href="/"]')).toHaveCount(0);
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Desligar a TV' })).toBeVisible();

    // O segredo viajou só no corpo do aceite: nenhum endereço de pedido o carrega.
    expect(identity.requests.every((r) => !r.url.includes(invite.token))).toBe(true);
    expect(identity.requests.filter((r) => r.path === '/guest-invites/accept')).toHaveLength(1);
    expect(
      identity.requests.find((r) => r.path === '/guest-invites/accept')?.headers[
        'x-uniover-client'
      ],
    ).toBe('web');

    // No painel Apps o convidado abre apps, mas não edita (renomear, fixar e tirar do controle são só do dono).
    await page.getByRole('button', { name: 'Apps da TV', exact: true }).click();
    const apps = page.getByRole('dialog', { name: 'Apps da TV' });
    await expect(apps).toBeVisible();
    await expect(apps.getByRole('button', { name: /^Renomear / })).toHaveCount(0);
    await expect(apps.getByRole('button', { name: /^(Fixar|Tirar) / })).toHaveCount(0);
    await expect(apps.getByRole('button', { name: 'Editar', exact: true })).toHaveCount(0);
    // Abre todo app instalado, também o que está fora do controle; o que saiu da TV não aparece.
    await expect(apps.locator('.launch')).toHaveCount(SHORTCUTS.length + 1);
    await expect(apps.getByRole('button', { name: 'Atalho 5', exact: true })).toHaveCount(0);
    await apps.getByRole('button', { name: 'Atalho 4', exact: true }).click();
    await expect.poll(() => tv.count(`/shortcuts/${outOfControl.id}/launch`)).toBe(1);
    await expect(apps).toHaveCount(0);
    expect(tv.count(`/shortcuts/${gone.id}/launch`)).toBe(0);

    // E usa a TV inteira: tecla, e desligar sem passkey.
    const before = tv.keysSent().length;
    await page.getByRole('button', { name: 'Mudo', exact: true }).click();
    await expect.poll(() => tv.keysSent().slice(before)).toEqual(['MUTE']);
    await page.getByRole('button', { name: 'Desligar a TV' }).click();
    const sheet = page.getByRole('dialog', { name: 'Desligar a TV?' });
    await sheet.getByRole('button', { name: 'Desligar', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    expect(tv.count('/power/off')).toBe(1);
    expect(identity.requests.some((r) => r.path === '/step-up/options')).toBe(false);

    await screenshot(page, `test-results/guests-tv-${info.project.name}.png`);
    await expectNoHorizontalScroll(page);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectNoSeriousViolations(page);
    }
  });

  test('qualquer outra tela o devolve ao controle, e nenhuma chamada fora da TV é feita', async ({
    page,
  }) => {
    const invite = identity.seedInvite();
    await acceptInvite(page, invite.token);
    await expect(page).toHaveURL(/\/tv$/);
    await showTv(page);

    const urls: string[] = [];
    page.on('request', (request) => urls.push(new URL(request.url()).pathname));
    for (const path of [
      '/',
      '/treino',
      '/ajustes',
      '/ajustes/aparelhos',
      '/ajustes/creditos',
      '/nao-existe',
    ]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/tv$/);
      await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
      await expect(page.getByRole('link', { name: /Início/ })).toHaveCount(0);
    }

    // Recarregar mantém a sessão (cookie) e o papel: continua só no controle.
    await page.reload();
    await expect(page).toHaveURL(/\/tv$/);

    const outside = urls.filter(
      (path) =>
        path.startsWith('/api/v1/devices') ||
        path.startsWith('/api/v1/training') ||
        /\/api\/v1\/identity\/(passkeys|guests|guest-invites|step-up)/.test(path),
    );
    expect(outside).toEqual([]);
    expect(identity.requests.map((r) => r.path)).not.toContain('/passkeys');
  });

  test('convite que não vale mais, ou endereço sem convite, explica o que fazer', async ({
    page,
  }) => {
    await page.goto('/convite#' + 'a'.repeat(43));
    await page.getByLabel('E-mail').fill(GUEST.email);
    await page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
    await page.getByLabel('Repita a senha').fill(GUEST.password);
    await page.getByRole('button', { name: 'Criar conta e entrar' }).click();
    await expect(page.getByRole('alert')).toContainText('Este convite não vale mais');
    await expect(page).toHaveURL(/\/convite$/);

    await page.goto('/convite');
    await expect(page.getByRole('alert')).toContainText('Abra o link do convite');
    await expect(page.getByRole('link', { name: 'Já tenho conta: entrar' })).toBeVisible();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectNoSeriousViolations(page);
    }
  });

  test('o convidado entra depois com o e-mail e a senha que escolheu e vai direto ao controle', async ({
    page,
  }) => {
    const invite = identity.seedInvite();
    await acceptInvite(page, invite.token);
    await expect(page).toHaveURL(/\/tv$/);
    identity.loggedIn = false;
    identity.role = 'owner';

    await page.goto('/entrar');
    await page.getByLabel('E-mail').fill(GUEST.email);
    await page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page).toHaveURL(/\/tv$/);
    await showTv(page);
  });
});
