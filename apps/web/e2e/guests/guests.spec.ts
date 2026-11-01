import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';
import {
  GUEST,
  IdentityMock,
  OWNER,
  TV_CONTROL_ONLY,
  mockIdentityApi,
} from '../auth/identity-mock';
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
  await expect(
    page.getByRole('heading', { level: 1, name: 'Criar conta', exact: true }),
  ).toBeVisible();
  await page.getByLabel('E-mail').fill(GUEST.email);
  await page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
  await page.getByLabel('Repita a senha').fill(GUEST.password);
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
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
    await page.goto('/ajustes/seguranca');

    // Sem passkey cadastrada não há como confirmar: cadastra uma, como o dono faz em Segurança.
    await page.getByRole('button', { name: 'Cadastrar passkey' }).click();
    await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
    await page.getByLabel('Nome da passkey (opcional)').fill('Notebook');
    await page.getByRole('button', { name: 'Cadastrar', exact: true }).click();
    await expect(page.getByText('Passkey cadastrada.', { exact: true })).toBeVisible();

    // O convite mora em Pessoas.
    await page.goto('/ajustes/pessoas');
    await expect(page.getByRole('heading', { level: 1, name: 'Pessoas' })).toBeVisible();
    // O título é um só: o do cabeçalho da tela (h1), sem repetir no conteúdo (nenhum h2 com o mesmo nome).
    await expect(page.getByRole('heading', { level: 2, name: 'Pessoas e Permissões' })).toHaveCount(
      0,
    );
    await expect(page.getByText('Ninguém foi convidado ainda.')).toBeVisible();
    await page.getByRole('tab', { name: 'Convites' }).click();
    await page.getByRole('button', { name: 'Convidar alguém' }).click();
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
    const posts = identity.requests.filter(
      (r) => r.path === '/guest-invites' && r.method === 'POST',
    );
    expect(posts).toHaveLength(2);
    // O padrão do convite é o modelo "só controlar a TV", enviado por extenso nas duas tentativas.
    expect(posts.map((r) => r.body)).toEqual([
      { displayName: GUEST.displayName, permissions: [...TV_CONTROL_ONLY] },
      { displayName: GUEST.displayName, permissions: [...TV_CONTROL_ONLY] },
    ]);

    // O dono vê o pendente na lista (sem segredo) e o revoga.
    await expect(page.locator('app-guests-section .person .name')).toHaveText([GUEST.displayName]);
    await screenshot(page, `test-results/guests-owner-${info.project.name}.png`);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectNoSeriousViolations(page);
    }
    await expectNoHorizontalScroll(page);

    await page.getByRole('button', { name: `Revogar o convite de ${GUEST.displayName}` }).click();
    await page.getByRole('button', { name: 'Revogar', exact: true }).click();
    await expect(page.getByText('Convite revogado.')).toBeVisible();
    await page.getByRole('tab', { name: 'Pessoas' }).click();
    await expect(page.getByText('Ninguém foi convidado ainda.')).toBeVisible();
    expect(identity.invites[0].status).toBe('revoked');
  });
});

test.describe('convidado: Início só com os módulos permitidos', () => {
  test('aceita o convite, define a própria senha e cai na Início sem atalhos de administrador', async ({
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
    await expect(
      page.getByRole('heading', { level: 1, name: 'Criar conta', exact: true }),
    ).toBeVisible();

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
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await expect(page.locator('#invite-confirmation-status')).toHaveText(
      'As senhas ainda não são iguais.',
    );
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByLabel('Senha', { exact: true }).fill('curta');
    await page.getByLabel('Repita a senha').fill('curta');
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('ao menos 10 caracteres');
    expect(identity.requests.some((r) => r.path === '/guest-invites/accept')).toBe(false);

    await page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
    await page.getByLabel('Repita a senha').fill(GUEST.password);
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('article.card h3')).toHaveText([
      'TV',
      'Controle do PC',
      'Rede da Casa',
      'Backup de Fotos',
    ]);
    await expect(page.locator('.shortcuts')).toHaveCount(0);
    await expect(page.locator('.hero-settings')).toHaveAttribute('aria-label', 'Configurações');
    // O convidado com a TV vê o estado do agente DELE (a bolinha), nunca o aviso de queda do computador do dono.
    await expect(page.locator('.agent-status')).toHaveCount(1);
    await expect(page.locator('.agent-alert')).toHaveCount(0);
    await page.getByRole('link', { name: 'TV: Abrir controle' }).click();
    await showTv(page);
    await expect(page.getByRole('link', { name: 'Voltar ao Início' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Configurações' })).toHaveCount(0);
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
    await page.getByRole('button', { name: 'Mais opções', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Mais opções' })
      .getByRole('button', { name: 'Apps da TV', exact: true })
      .click();
    const apps = page.getByRole('dialog', { name: 'Apps da TV' });
    await expect(apps).toBeVisible();
    await expect(apps.getByRole('button', { name: /^Renomear / })).toHaveCount(0);
    await expect(apps.getByRole('button', { name: /^(Fixar|Tirar) / })).toHaveCount(0);
    await expect(apps.getByRole('button', { name: 'Editar', exact: true })).toHaveCount(0);
    // Mudar a ordem da fileira de atalhos também é só do dono: o convidado não tem as setas.
    await expect(apps.getByRole('button', { name: /^Mover / })).toHaveCount(0);

    // "Limpar a TV" é comando da TV como os outros: o convidado também o vê e o usa.
    await apps.getByRole('button', { name: 'Limpar a TV' }).click();
    const cleanSheet = page.getByRole('dialog', { name: 'Limpar a TV?' });
    await expect(cleanSheet).toBeVisible();
    await cleanSheet.getByRole('button', { name: 'Limpar', exact: true }).click();
    await expect(cleanSheet).toHaveCount(0);
    await expect.poll(() => tv.count('/cleanup')).toBe(1);
    await expect(apps.getByText('Fechou 6 apps e liberou cerca de 380 MB.')).toBeVisible();
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

  test('as telas do dono o devolvem à Início, e nenhuma chamada administrativa é feita', async ({
    page,
  }) => {
    const invite = identity.seedInvite();
    await acceptInvite(page, invite.token);
    await expect(page).toHaveURL(/\/$/);

    const urls: string[] = [];
    page.on('request', (request) => urls.push(new URL(request.url()).pathname));
    for (const path of [
      '/',
      '/treino',
      '/ajustes/pessoas',
      '/ajustes/sistema',
      '/ajustes/creditos',
      '/nao-existe',
    ]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator('article.card h3')).toHaveText([
        'TV',
        'Controle do PC',
        'Rede da Casa',
        'Backup de Fotos',
      ]);
      await expect(page.locator('.shortcuts')).toHaveCount(0);
    }

    // Recarregar mantém a sessão (cookie) e o papel: continua na Início filtrada.
    await page.reload();
    await expect(page).toHaveURL(/\/$/);

    const outside = urls.filter(
      (path) =>
        path.startsWith('/api/v1/devices') ||
        path.startsWith('/api/v1/training') ||
        path.startsWith('/api/v1/tv/config') ||
        /\/api\/v1\/identity\/(passkeys|guests|guest-invites|step-up)/.test(path),
    );
    expect(outside).toEqual([]);
    expect(identity.requests.map((r) => r.path)).not.toContain('/passkeys');
  });

  test('a convidada chega às Configurações pela Início (o topo da TV não tem engrenagem): Perfil, Aparência, Dispositivos e Sobre', async ({
    page,
  }) => {
    const invite = identity.seedInvite();
    await acceptInvite(page, invite.token);
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('link', { name: 'TV: Abrir controle' }).click();
    await showTv(page);

    // O topo da TV: a volta e o menu à esquerda antes do nome; à direita o ponto de estado e o desligar. Sem engrenagem.
    const header = page.locator('.tv > header.head');
    await expect(header.getByRole('link', { name: 'Configurações' })).toHaveCount(0);
    const backBox = (await header.getByRole('link', { name: 'Voltar ao Início' }).boundingBox())!;
    const menuBox = (await header
      .getByRole('button', { name: 'Mais opções', exact: true })
      .boundingBox())!;
    const nameBox = (await header.locator('h1').boundingBox())!;
    const powerBox = (await header.getByRole('button', { name: 'Desligar a TV' }).boundingBox())!;
    expect(Math.abs(menuBox.y - backBox.y), 'na mesma linha da volta').toBeLessThanOrEqual(1);
    expect(menuBox.x, 'depois da volta').toBeGreaterThanOrEqual(backBox.x + backBox.width);
    expect(nameBox.x, 'antes do nome').toBeGreaterThanOrEqual(menuBox.x + menuBox.width);
    expect(powerBox.x, 'o desligar depois do nome').toBeGreaterThanOrEqual(
      nameBox.x + nameBox.width - 1,
    );
    await expect(header.locator('.actions').getByRole('button')).toHaveCount(2);

    // As Configurações ficam na Início: a seta leva até lá e o botão da Início abre a lista.
    await header.getByRole('link', { name: 'Voltar ao Início' }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('link', { name: 'Configurações' }).click();
    await expect(page).toHaveURL(/\/ajustes$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Configurações' })).toBeVisible();
    await expect(page.locator('a.ui-row .ui-row-title')).toHaveText([
      'Perfil',
      'Aparência',
      'Segurança',
      'Dispositivos',
      'Sobre',
    ]);
    // "Dispositivos" é só o download do conector do PC (a convidada tem a TV); o resto do administrador não aparece.
    await expect(page.getByRole('link', { name: /Dispositivos/ })).toHaveAttribute(
      'href',
      '/ajustes/dispositivos',
    );
    for (const name of ['Pessoas e Permissões', 'Auditoria', 'Sistema']) {
      await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    }
    await expect(page.locator('a.ui-row .ui-row-sub')).toHaveCount(0);

    await page.getByRole('button', { name: 'Voltar ao Início' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('a sessão da convidada nunca chama rota de administrador nas Configurações, e o servidor recusa se ela chamar à mão', async ({
    page,
  }) => {
    const invite = identity.seedInvite();
    await acceptInvite(page, invite.token);
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('link', { name: 'TV: Abrir controle' }).click();
    await showTv(page);

    const urls: string[] = [];
    page.on('request', (request) => urls.push(new URL(request.url()).pathname));
    const before = identity.requests.length;
    for (const path of [
      '/ajustes',
      '/ajustes/perfil',
      '/ajustes/aparencia',
      '/ajustes/seguranca',
      '/ajustes/sobre',
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
    // Segurança da convidada: só as próprias sessões, sem passkeys.
    await page.goto('/ajustes/seguranca');
    await expect(page.getByRole('heading', { level: 1, name: 'Segurança' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sessões de Acesso' })).toBeVisible();
    await expect(page.getByText(/passkey/i)).toHaveCount(0);
    // Salvar o nome também é só da própria conta.
    await page.goto('/ajustes/perfil');
    await page.getByLabel('Como devemos te chamar').fill('Alice Souza');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('Nome salvo.')).toBeVisible();

    const adminRoute =
      /\/api\/v1\/(devices|training)|\/api\/v1\/identity\/(passkeys|guests|guest-invites|step-up)/;
    expect(urls.filter((path) => adminRoute.test(path))).toEqual([]);
    const sent = identity.requests.slice(before).map((r) => `${r.method} ${r.path}`);
    expect(sent.filter((request) => /passkeys|guests|guest-invites|step-up/.test(request))).toEqual(
      [],
    );
    // Só a leitura pública da versão, o renovar da sessão, a própria conta, o salvar do nome e a lista das próprias sessões.
    expect(new Set(sent.map((request) => request.replace(/^(GET|POST|PATCH) /, '')))).toEqual(
      new Set(['/health/version', '/auth/refresh', '/me', '/sessions']),
    );

    // O servidor recusa o que ela chamar à mão: o papel dela não passa nessas rotas (a API tem o teste dela; aqui o
    // simulador reproduz o mesmo contrato).
    const token = identity.issuedTokens.at(-1)!;
    const statuses = await page.evaluate(async (bearer) => {
      const out: number[] = [];
      for (const path of ['/passkeys', '/guests', '/guest-invites']) {
        const response = await fetch('/api/v1/identity' + path, {
          headers: { Authorization: 'Bearer ' + bearer },
        });
        out.push(response.status);
      }
      return out;
    }, token);
    expect(statuses).toEqual([403, 403, 403]);
  });

  test('o Perfil da convidada mostra o que ela pode fazer, pelas permissões da conta', async ({
    page,
  }) => {
    const invite = identity.seedInvite();
    await acceptInvite(page, invite.token);
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('link', { name: 'TV: Abrir controle' }).click();
    await showTv(page);
    await page.goto('/ajustes/perfil');
    await expect(page.getByText('Convidado', { exact: true })).toBeVisible();
    await expect(page.locator('.abilities-list li')).toHaveText([
      'Controlar a TV',
      'Desligar a TV',
      'Abrir apps',
      'Ver o histórico',
    ]);
    await expect(page.getByText('Editar atalhos')).toHaveCount(0);
  });

  test('convite que não vale mais, ou endereço sem convite, explica o que fazer', async ({
    page,
  }) => {
    await page.goto('/convite#' + 'a'.repeat(43));
    await page.getByLabel('E-mail').fill(GUEST.email);
    await page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
    await page.getByLabel('Repita a senha').fill(GUEST.password);
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
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
    await expect(page).toHaveURL(/\/$/);
    identity.loggedIn = false;
    identity.role = 'owner';

    await page.goto('/entrar');
    await page.getByLabel('E-mail').fill(GUEST.email);
    await page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('link', { name: 'TV: Abrir controle' }).click();
    await showTv(page);
  });
});

test.describe('convidado pausado', () => {
  test('a entrada diz só "Acesso Pausado", sem detalhe, e a conta volta a entrar quando é retomada', async ({
    page,
  }, info) => {
    const invite = identity.seedInvite();
    await acceptInvite(page, invite.token);
    await expect(page).toHaveURL(/\/$/);
    identity.loggedIn = false;
    identity.role = 'owner';
    identity.guests[0].pausedAt = '2026-10-19T16:00:00Z';

    await page.goto('/entrar');
    await page.getByLabel('E-mail').fill(GUEST.email);
    await page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    const notice = page.getByRole('alert').filter({ hasText: 'Acesso Pausado' });
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(/^\s*Acesso Pausado\s*$/);
    await expect(page).toHaveURL(/\/entrar/);
    await expectNoHorizontalScroll(page);
    await screenshot(page, `test-results/acesso-pausado-${info.project.name}.png`);

    identity.guests[0].pausedAt = null;
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe('convidado sem módulo liberado', () => {
  test('vê só os três planejados, com o último centralizado', async ({ page }) => {
    identity.guests.push({
      id: '00000000-0000-4000-8000-000000000071',
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-21T15:00:00Z',
      disabledAt: null,
      permissions: [],
    });
    identity.role = 'guest';
    identity.loggedIn = true;
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    const cards = page.locator('article.card');
    await expect(cards.locator('h3')).toHaveText([
      'Controle do PC',
      'Rede da Casa',
      'Backup de Fotos',
    ]);
    await expect(page.locator('.agent-status')).toHaveCount(0);
    await expect(page.locator('.shortcuts')).toHaveCount(0);
    await expect(cards.last().locator('xpath=..')).toHaveClass(/\bcentered-last\b/);
    await expectNoHorizontalScroll(page);

    // A última linha tem só um cartão: ele conserva a mesma largura e fica no eixo da própria grade.
    const grid = (await page.locator('.guest-grid').boundingBox())!;
    const first = (await cards.nth(0).boundingBox())!;
    const last = (await cards.nth(2).boundingBox())!;
    expect(last.width).toBeCloseTo(first.width, 1);
    expect(Math.abs(last.x + last.width / 2 - (grid.x + grid.width / 2))).toBeLessThan(1);
  });
});
