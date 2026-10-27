import { readFileSync } from 'node:fs';
import { Page, TestInfo } from '@playwright/test';
import { GUEST, IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { AuditMock, MockAuditItem, mockAuditApi } from './audit-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker. Fuso e idioma fixos: as
// datas saem no formato do navegador, e o teste não depende da máquina que o roda.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

const OWNER_ID = 'u1';
const BRUNO_ID = '00000000-0000-4000-8000-0000000000a1';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

let identity: IdentityMock;
let audit: AuditMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  await mockTvApi(context, identity);
  // Depois do mock de identidade: a rota registrada por último vence, e a trilha mora sob o mesmo prefixo.
  audit = await mockAuditApi(context, identity);
  await installFakeEventSource(page);
});

/**
 * Uma trilha variada, da mais nova para a mais velha: entradas, recusas, comandos da TV, uma mudança de permissões e uma
 * conta apagada. O instante é relativo a agora, para o ano de cada linha não depender do dia em que o teste roda.
 */
function seedTrail(count = 60): MockAuditItem[] {
  const owner = { id: OWNER_ID, displayName: 'Dono da Casa' };
  const bruno = { id: BRUNO_ID, displayName: 'Bruno' };
  const base = { target: null, targetAccount: null, detail: null };
  const templates: Omit<MockAuditItem, 'id' | 'occurredAt'>[] = [
    {
      ...base,
      module: 'identity',
      action: 'login_succeeded',
      outcome: 'success',
      actor: owner,
      ip: '203.0.113.7',
      userAgent: SAFARI_IPHONE,
    },
    {
      ...base,
      module: 'tv',
      action: 'tv.key',
      outcome: 'success',
      actor: bruno,
      target: 'VOLUME_UP/SHORT',
      ip: '198.51.100.20',
      userAgent: CHROME_ANDROID,
    },
    {
      ...base,
      module: 'identity',
      action: 'login_failed',
      outcome: 'failure',
      actor: { id: 'apagada', displayName: null },
      ip: '192.0.2.44',
      userAgent: CHROME_ANDROID,
    },
    {
      ...base,
      module: 'identity',
      action: 'permissions_changed',
      outcome: 'success',
      actor: owner,
      targetAccount: bruno,
      detail: '+tv:launch|-',
      ip: '203.0.113.7',
      userAgent: SAFARI_IPHONE,
    },
    {
      ...base,
      module: 'devices',
      action: 'pairing_approved',
      outcome: 'success',
      actor: owner,
      target: 'PC de casa',
      ip: '203.0.113.7',
      userAgent: SAFARI_IPHONE,
    },
    {
      ...base,
      module: 'identity',
      action: 'login_locked',
      outcome: 'denied',
      actor: null,
      ip: '192.0.2.99',
      userAgent: null,
    },
    {
      ...base,
      module: 'tv',
      action: 'tv.text',
      outcome: 'failure',
      actor: bruno,
      target: 'length=8',
      ip: null,
      userAgent: null,
    },
  ];
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    ...templates[i % templates.length],
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    occurredAt: new Date(now - (i + 1) * 7 * 60_000).toISOString(),
  }));
}

/** A convidada com a sessão aberta (o papel decide o que `/me` devolve e o que a trilha recusa). */
function signInAsGuest(): void {
  identity.guests.push({
    id: '00000000-0000-4000-8000-000000000051',
    displayName: GUEST.displayName,
    email: GUEST.email,
    password: GUEST.password,
    createdAt: '2026-10-19T15:00:00Z',
    disabledAt: null,
  });
  identity.role = 'guest';
}

function seedPeople(): void {
  identity.guests.push({
    id: BRUNO_ID,
    displayName: 'Bruno',
    email: 'bruno@exemplo.com',
    password: 'x',
    createdAt: '2026-10-10T10:00:00Z',
    disabledAt: null,
  });
}

async function open(page: Page, scheme: Scheme = 'light') {
  // Movimento reduzido: as animações de entrada saem do caminho e o axe mede as cores finais (o executor da CI é lento).
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.goto('/ajustes/auditoria');
  await expect(page.getByRole('heading', { level: 1, name: 'Auditoria' })).toBeVisible();
}

async function openWithRows(page: Page, scheme: Scheme = 'light') {
  await open(page, scheme);
  await expect(page.locator('button.entry').first()).toBeVisible();
}

const shot = (info: TestInfo, name: string, scheme: Scheme) =>
  `test-results/audit-screen/${name}-${info.project.name}-${scheme}.png`;

/** O roteiro de toda tela: sem rolagem de lado, print, alvos de 44 px e o axe sem nenhuma violação. */
async function check(
  page: Page,
  info: TestInfo,
  name: string,
  scheme: Scheme,
  options: { fullPage?: boolean } = {},
) {
  await settle(page);
  await expectNoHorizontalScroll(page);
  await screenshot(page, shot(info, name, scheme), { fullPage: options.fullPage ?? true });
  expect(await smallTargets(page)).toEqual([]);
  await expectNoA11yViolations(page);
}

const filtersButton = (page: Page) => page.getByRole('button', { name: /^Filtros/ });
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Filtros' });
const chips = (page: Page) => page.locator('.applied-chip');

/** Abre a folha, marca estas opções (rótulos dos chips) e aplica. */
async function applyFilters(page: Page, ...labels: string[]) {
  await filtersButton(page).click();
  await expect(sheet(page)).toBeVisible();
  for (const label of labels) await sheet(page).getByRole('radio', { name: label }).check();
  await sheet(page).getByRole('button', { name: 'Aplicar' }).click();
  await expect(sheet(page)).toHaveCount(0);
}

test.describe('Ajustes > Auditoria', () => {
  test('a linha Auditoria da lista leva à tela e a seta volta para a lista', async ({ page }) => {
    audit.items = seedTrail();
    await page.goto('/ajustes');
    await page.getByRole('link', { name: /^Auditoria/ }).click();
    await expect(page).toHaveURL(/\/ajustes\/auditoria$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Auditoria' })).toBeVisible();
    await page.getByRole('link', { name: 'Voltar aos Ajustes' }).click();
    await expect(page).toHaveURL(/\/ajustes$/);
  });

  for (const scheme of SCHEMES) {
    test(`mostra a lista com pouca informação por linha, no tema ${scheme}`, async ({
      page,
    }, info) => {
      audit.items = seedTrail();
      await openWithRows(page, scheme);

      // A primeira página (e só ela): nunca a trilha inteira.
      await expect(page.locator('button.entry')).toHaveCount(25);
      const first = page.locator('button.entry').first();
      await expect(first.locator('.ui-row-title')).toHaveText('Entrou na conta');
      await expect(first.locator('.ui-row-sub')).toContainText('Dono da Casa');
      await expect(first.locator('.result')).toHaveText('Sucesso');
      // A conta apagada, o resultado de erro e o de recusa têm texto próprio; nada de e-mail nem de código técnico.
      await expect(
        page.locator('button.entry', { hasText: 'Conta apagada' }).first(),
      ).toContainText('Erro');
      await expect(
        page.locator('button.entry', { hasText: 'Entrada bloqueada' }).first(),
      ).toContainText('Recusado');
      await expect(page.locator('button.entry', { hasText: 'Sem conta' }).first()).toBeVisible();
      await expect(page.locator('main')).not.toContainText('@');
      await expect(page.locator('main')).not.toContainText('login_failed');
      // IP e aparelho ficam atrás de um toque.
      await expect(page.locator('main')).not.toContainText('203.0.113.7');
      await expect(page.getByText('Estes registros ficam guardados por segurança')).toBeVisible();
      await expect(page.getByText('Guardamos por 180 dias')).toBeVisible();
      await check(page, info, 'audit-list', scheme);
    });

    test(`abre os detalhes de uma linha com um toque, no tema ${scheme}`, async ({
      page,
    }, info) => {
      audit.items = seedTrail();
      await openWithRows(page, scheme);

      const row = page.locator('button.entry', { hasText: 'Permissões alteradas' }).first();
      await row.click();
      await expect(row).toHaveAttribute('aria-expanded', 'true');
      const details = page.locator('dl.details');
      await expect(details).toBeVisible();
      await expect(details).toContainText('Bruno');
      await expect(details).toContainText('Passou a poder: Abrir apps');
      await expect(details).toContainText('Conta e acesso');
      await expect(details).toContainText('203.0.113.7');
      await expect(details).toContainText('Safari no iPhone');
      await expect(page.locator('main')).not.toContainText('AppleWebKit');
      await check(page, info, 'audit-details', scheme);

      await row.click();
      await expect(page.locator('dl.details')).toHaveCount(0);
    });

    test(`a folha de filtros cabe na tela, no tema ${scheme}`, async ({ page }, info) => {
      audit.items = seedTrail();
      seedPeople();
      await openWithRows(page, scheme);

      await filtersButton(page).click();
      await expect(sheet(page)).toBeVisible();
      await expect(sheet(page).getByRole('radio', { name: 'Bruno' })).toBeVisible();
      await expect(sheet(page).getByRole('radio', { name: 'Dono da Casa (você)' })).toBeVisible();
      await expect(sheet(page).getByRole('checkbox', { name: 'TV' })).toBeVisible();
      // As ações só aparecem para o módulo escolhido: uma lista de trinta chips pesaria a folha.
      await expect(
        sheet(page).getByText('Escolha um módulo para ver as ações dele.'),
      ).toBeVisible();
      await sheet(page).getByRole('checkbox', { name: 'TV' }).check();
      await expect(sheet(page).getByRole('radio', { name: 'Tecla enviada à TV' })).toBeVisible();
      await expect(sheet(page).getByRole('radio', { name: 'Entrou na conta' })).toHaveCount(0);
      await expect(sheet(page).getByRole('radio', { name: 'Recusado' })).toBeVisible();
      await check(page, info, 'audit-filters', scheme, { fullPage: false });

      // Sair sem aplicar não muda nada e devolve o foco ao botão.
      await sheet(page).getByRole('button', { name: 'Cancelar' }).click();
      await expect(sheet(page)).toHaveCount(0);
      await expect(filtersButton(page)).toBeFocused();
      await expect(chips(page)).toHaveCount(0);
    });

    test(`o filtro aplicado fica visível e se limpa com um toque, no tema ${scheme}`, async ({
      page,
    }, info) => {
      audit.items = seedTrail();
      await openWithRows(page, scheme);

      await applyFilters(page, 'Erro', 'Últimos 7 dias');
      await expect(chips(page)).toHaveText(['Resultado: Erro', 'Últimos 7 dias']);
      await expect(filtersButton(page)).toHaveAccessibleName('Filtros 2');
      // Só erros: a lista inteira recarregou do começo com o filtro.
      const rows = page.locator('button.entry');
      for (const text of await rows.locator('.result').allTextContents()) {
        expect(text.trim()).toBe('Erro');
      }
      const last = audit.listRequests().at(-1)!.query;
      expect(last.get('outcome')).toBe('failure');
      expect(last.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(last.has('cursor')).toBe(false);
      await check(page, info, 'audit-filtered', scheme);

      // Um toque no chip tira só aquele filtro.
      await page.getByRole('button', { name: 'Remover filtro: Resultado: Erro' }).click();
      await expect(chips(page)).toHaveText(['Últimos 7 dias']);
      await expect.poll(() => audit.listRequests().at(-1)!.query.has('outcome')).toBe(false);
      await page.getByRole('button', { name: 'Remover filtro: Últimos 7 dias' }).click();
      await expect(chips(page)).toHaveCount(0);
      await expect(filtersButton(page)).toHaveAccessibleName('Filtros');
    });

    test(`diz "Nenhum registro com esses filtros" quando nada combina, no tema ${scheme}`, async ({
      page,
    }, info) => {
      audit.items = seedTrail().filter((item) => item.outcome !== 'denied');
      await openWithRows(page, scheme);

      await applyFilters(page, 'Recusado');
      await expect(page.getByText('Nenhum registro com esses filtros.')).toBeVisible();
      await check(page, info, 'audit-empty', scheme);

      await page.getByRole('button', { name: 'Limpar tudo' }).click();
      await expect(page.locator('button.entry').first()).toBeVisible();
      await expect(chips(page)).toHaveCount(0);
    });

    test(`mostra o erro e deixa tentar de novo, no tema ${scheme}`, async ({ page }, info) => {
      audit.items = seedTrail();
      audit.failList = 1;
      await open(page, scheme);

      await expect(page.getByText('Não foi possível carregar os registros agora.')).toBeVisible();
      await check(page, info, 'audit-error', scheme);

      await page.getByRole('button', { name: 'Tentar de novo' }).click();
      await expect(page.locator('button.entry').first()).toBeVisible();
      await expect.poll(() => audit.listRequests().length).toBeGreaterThanOrEqual(2);
    });
  }

  test('"Carregar mais" segue o cursor e a tela nunca carrega tudo', async ({ page }) => {
    audit.items = seedTrail(60);
    await openWithRows(page);
    await expect(page.locator('button.entry')).toHaveCount(25);
    expect(audit.listRequests()).toHaveLength(1);
    expect(audit.listRequests()[0].query.get('limit')).toBe('25');
    expect(audit.listRequests()[0].query.has('cursor')).toBe(false);

    await page.getByRole('button', { name: 'Carregar mais' }).click();
    await expect(page.locator('button.entry')).toHaveCount(50);
    expect(audit.listRequests()[1].query.get('cursor')).toBeTruthy();

    await page.getByRole('button', { name: 'Carregar mais' }).click();
    await expect(page.locator('button.entry')).toHaveCount(60);
    await expect(page.getByRole('button', { name: 'Carregar mais' })).toHaveCount(0);
    // Toda página pediu o mesmo tamanho pequeno.
    expect(audit.listRequests().map((r) => r.query.get('limit'))).toEqual(['25', '25', '25']);
  });

  test('exporta o CSV com os mesmos filtros e baixa o arquivo', async ({ page }) => {
    audit.items = seedTrail();
    await openWithRows(page);
    await applyFilters(page, 'Erro');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Exportar CSV' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('auditoria-20261021-1500.csv');
    const file = readFileSync((await download.path())!, 'utf8');
    expect(file).toContain('occurredAt');
    expect(file).toContain('"failure"');
    expect(file).not.toContain('"success"');

    await expect(
      page.getByText('Arquivo baixado. Esta exportação ficou registrada na auditoria.'),
    ).toBeVisible();
    const exported = audit.exportRequests();
    expect(exported).toHaveLength(1);
    expect(exported[0].query.get('outcome')).toBe('failure');
    // Mesmos filtros, sem página.
    expect(exported[0].query.has('limit')).toBe(false);
    expect(exported[0].query.has('cursor')).toBe(false);
  });

  test('avisa quando o servidor cortou a exportação', async ({ page }, info) => {
    audit.items = seedTrail();
    audit.truncateExport = true;
    await openWithRows(page);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Exportar CSV' }).click(),
    ]);
    expect(download.suggestedFilename()).toContain('auditoria');
    await expect(
      page.getByText('O arquivo traz só os registros mais recentes', { exact: false }),
    ).toBeVisible();
    await check(page, info, 'audit-export-truncated', 'light');
  });

  test('sem rede diz isso com calma, bloqueia a exportação e volta sozinha com a rede', async ({
    page,
    context,
  }, info) => {
    audit.items = seedTrail();
    await openWithRows(page);

    await context.setOffline(true);
    await expect(page.getByRole('button', { name: 'Exportar CSV' })).toBeDisabled();
    await applyFilters(page, 'Erro');
    await expect(
      page.getByText('A auditoria só funciona com internet', { exact: false }),
    ).toBeVisible();
    await expect(page.getByText('Não foi possível')).toHaveCount(0);
    await check(page, info, 'audit-offline', 'light');

    await context.setOffline(false);
    await expect(page.locator('button.entry').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Exportar CSV' })).toBeEnabled();
  });

  test('o administrador que perde o papel no meio do uso é levado para onde as outras telas dele levam', async ({
    page,
  }) => {
    audit.items = seedTrail();
    await openWithRows(page);

    // O papel da mesma conta muda no servidor: o token e /me ainda têm o mesmo sub/id.
    // Trocar também o ID simularia uma resposta de outra conta, corretamente descartada pela sessão.
    identity.role = 'guest';
    await page.getByRole('button', { name: 'Carregar mais' }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe('Ajustes > Auditoria para quem não é administrador', () => {
  test('a convidada não vê o item, e o endereço digitado à mão a leva à Início sem nenhuma chamada à trilha', async ({
    page,
  }) => {
    audit.items = seedTrail();
    signInAsGuest();
    await page.goto('/ajustes');
    await expect(page.getByRole('heading', { level: 1, name: 'Configurações' })).toBeVisible();
    await expect(page.getByText('Auditoria')).toHaveCount(0);
    await expect(page.locator('a[href="/ajustes/auditoria"]')).toHaveCount(0);

    await page.goto('/ajustes/auditoria');
    await expect(page).toHaveURL(/\/$/);
    expect(audit.requests).toEqual([]);
  });
});
