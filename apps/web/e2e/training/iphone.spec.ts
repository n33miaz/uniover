import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Page, TestInfo } from '@playwright/test';
import { GUEST, IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { settle, smallTargets } from '../screens/screen-helpers';
import { TrainingServer, mockTrainingApi } from './support/training-server';
import { seedTraining } from './support/training-seed';
import {
  chooseMuscle,
  openTraining,
  trainingDbName,
  expectOfflineIcon,
} from './support/training-pages';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block', actionTimeout: 20_000 });

/**
 * A jornada de quem só usa o Treino, num iPhone: convite, nome, Treino aberto direto, instalação e o que muda quando o
 * aparelho está sem rede. Os prints só saem com `TRAINING_IPHONE_SHOTS` apontando para uma pasta (a esteira não gasta
 * tempo de captura no WebKit do Linux).
 */
const SHOTS = process.env['TRAINING_IPHONE_SHOTS'];

const TRAINING_ONLY = ['module:training'];
/** O id da conta do convidado: nomeia o banco local dele no aparelho (um por conta). */
const GUEST_ID = '00000000-0000-4000-8000-000000000061';
const RAPHAEL = {
  name: 'Raphael',
  chosen: 'Raphael Souza',
  email: 'raphael@exemplo.com',
  password: 'senha-do-raphael-123',
};

// A folha abre sozinha ~3 s depois da tela pronta; quem prova que ela NÃO abriu espera um pouco mais que isso.
const AFTER_DELAY_MS = 3600;

let identity: IdentityMock;
let server: TrainingServer;
/** Toda requisição à TV que a página (ou o service worker) fez neste teste. */
let tvRequests: string[];

test.beforeEach(async ({ context }) => {
  tvRequests = [];
  context.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/v1/tv')) tvRequests.push(request.url());
  });
  identity = await mockIdentityApi(context);
  server = await mockTrainingApi(context);
  seedTraining(server);
});

/** O convidado já existe e tem sessão (o app o reconhece pelo refresh), com as permissões dadas. */
function signInAsGuest(permissions: string[]) {
  identity.guests.push({
    id: GUEST_ID,
    displayName: GUEST.displayName,
    email: GUEST.email,
    password: GUEST.password,
    createdAt: '2026-10-21T15:00:00Z',
    disabledAt: null,
    permissions,
  });
  identity.role = 'guest';
  identity.loggedIn = true;
}

const gear = (page: Page) => page.getByRole('link', { name: 'Ajustes', exact: true });
const sheetOf = (page: Page) => page.getByRole('dialog', { name: 'Atalho na tela de início' });
const advice = (page: Page) =>
  page.getByRole('button', { name: /^Estes treinos estão salvos só neste navegador/ });

async function shot(page: Page, info: TestInfo, name: string, scheme: 'light' | 'dark') {
  if (!SHOTS) return;
  await settle(page);
  await screenshot(page, join(SHOTS, `${name}-${scheme}-${info.project.name}.png`));
}

async function useScheme(page: Page, scheme: 'light' | 'dark') {
  // Movimento reduzido junto: o axe e o print medem as cores finais, com a folha já parada.
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
    .toBe(scheme);
  await settle(page);
}

async function expectNoViolations(page: Page, scope?: string) {
  const axe = new AxeBuilder({ page });
  const { violations } = await (scope ? axe.include(scope) : axe).analyze();
  expect(
    violations.map(
      (v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
    ),
  ).toEqual([]);
}

/** Cada tela a conferir: sem violação do axe nos dois temas, sem rolagem lateral, alvos de toque de 44 px. */
async function expectSound(page: Page, info: TestInfo, name: string, scope?: string) {
  await expectNoHorizontalScroll(page);
  for (const scheme of ['light', 'dark'] as const) {
    await useScheme(page, scheme);
    await expectNoViolations(page, scope);
    expect(await smallTargets(page), 'alvos com menos de 44 px').toEqual([]);
    await shot(page, info, name, scheme);
  }
}

async function acceptTrainingInvite(page: Page) {
  const invite = identity.seedInvite(RAPHAEL.name, TRAINING_ONLY);
  identity.guestsStartUnconfirmed = true;
  await page.goto(`/convite#${invite.token}`);
  await page.getByLabel('E-mail').fill(RAPHAEL.email);
  await page.getByLabel('Senha', { exact: true }).fill(RAPHAEL.password);
  await page.getByLabel('Repita a senha').fill(RAPHAEL.password);
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
}

test.describe('convidado que só tem o Treino', () => {
  test('aceita o convite, escolhe o nome e abre na Início só com o Treino, sem passar pela TV', async ({
    page,
  }) => {
    const visited: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
    });

    await acceptTrainingInvite(page);
    await expect(page).toHaveURL(/\/boas-vindas$/);
    await expect(page.getByLabel('Seu nome')).toHaveValue(RAPHAEL.name);
    await page.getByLabel('Seu nome').fill(RAPHAEL.chosen);
    await page.getByRole('button', { name: 'Continuar' }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('article.card h3')).toHaveText([
      'Treino',
      'Controle do PC',
      'Rede da casa',
      'Backup de fotos',
    ]);
    await page.locator('article[data-module="training"] a.card-link').click();
    await expect(page).toHaveURL(/\/treino$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Treino' })).toBeVisible();
    await expect(page.locator('app-training-page')).toBeVisible();

    // O Treino tem cabeçalho próprio: no lugar da seta de voltar ao Início (que ele não tem), o botão redondo de configurações, como na TV.
    const header = page.locator('header');
    await expect(header.getByRole('link')).toHaveCount(1);
    await expect(gear(page)).toHaveAttribute('href', '/ajustes');
    await expect(header.locator('a[href="/"]')).toHaveCount(0);

    // Nunca passou pela TV: nem uma tela, nem uma requisição.
    expect(visited.filter((path) => path === '/tv' || path.startsWith('/tv/'))).toEqual([]);
    expect(tvRequests).toEqual([]);

    // O head já é o do Treino (o app trocou ao navegar do convite, sem recarregar): é o que o iOS grava ao compartilhar.
    await expect(page.locator('head link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/treino/manifest.webmanifest',
    );
    await expect(page.locator('head link[rel="apple-touch-icon"]')).toHaveAttribute(
      'href',
      '/treino/apple-touch-icon.png',
    );
    await expect(page).toHaveTitle('UniOver Treino');
  });

  test('na raiz não tem Voltar ao Início, mas conserva o Voltar da tela interna', async ({
    page,
  }, info) => {
    signInAsGuest(TRAINING_ONLY);
    await openTraining(page, '/treino');

    const header = page.locator('.training-header');
    await expect(header.getByRole('link', { name: /^Voltar/ })).toHaveCount(0);
    await expect(gear(page)).toHaveAttribute('href', '/ajustes');
    await screenshot(page, info.outputPath('raiz-sem-voltar.png'));

    await openTraining(page, '/treino/exercicios/novo');
    const back = page.getByRole('button', { name: 'Sair do formulário' });
    await expect(back).toBeVisible();
    await screenshot(page, info.outputPath('tela-interna-com-voltar.png'));
    await back.click();
    await expect(page).toHaveURL(/\/treino\/exercicios$/);
  });

  test('os Ajustes dele voltam para a Início, não para a TV', async ({ page }, info) => {
    signInAsGuest(TRAINING_ONLY);
    await page.goto('/treino');
    await expect(page.getByRole('heading', { level: 1, name: 'Treino' })).toBeVisible();
    for (const scheme of ['light', 'dark'] as const) {
      await useScheme(page, scheme);
      await shot(page, info, 'treino-so-treino', scheme);
    }
    await gear(page).click();
    await expect(page).toHaveURL(/\/ajustes$/);
    const back = page.getByRole('link', { name: 'Voltar ao Início' });
    await expect(back).toHaveAttribute('href', '/');
    await expect(page.getByRole('link', { name: 'Voltar ao controle' })).toHaveCount(0);
    await back.click();
    await expect(page).toHaveURL(/\/$/);
    expect(tvRequests).toEqual([]);
  });

  test('o endereço de início e as telas só do dono levam à Início; o do atalho abre o Treino', async ({
    page,
  }) => {
    signInAsGuest(TRAINING_ONLY);
    for (const path of ['/', '/ajustes/seguranca', '/nada-aqui']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator('article[data-module="training"]')).toBeVisible();
    }

    // O atalho da tela de início abre o endereço do manifest (`start_url`), com a barra no fim: tem de ser o Treino.
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'public', 'treino', 'manifest.webmanifest'), 'utf8'),
    ) as { start_url: string; scope: string };
    await page.goto(manifest.start_url);
    await expect(page.getByRole('heading', { level: 1, name: 'Treino' })).toBeVisible();
    await expect(page.locator('app-training-page')).toBeVisible();
    await expect(page).toHaveURL(/\/treino\/?$/);
    expect(tvRequests).toEqual([]);
  });

  test('os créditos das ilustrações abrem para quem usa o Treino', async ({ page }) => {
    signInAsGuest(TRAINING_ONLY);
    await page.goto('/ajustes/creditos');
    await expect(page).toHaveURL(/\/ajustes\/creditos$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Créditos' })).toBeVisible();
  });

  test('quem só tem a TV não entra no Treino: vai para a Início', async ({ context, page }) => {
    await mockTvApi(context, identity);
    await installFakeEventSource(page);
    signInAsGuest(['module:tv', 'tv:control']);
    await page.goto('/treino');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('app-training-page')).toHaveCount(0);
    await expect(page.locator('article[data-module="tv"]')).toBeVisible();
  });

  test('o dono continua no Início e abre o Treino pelo endereço', async ({ page }) => {
    identity.role = 'owner';
    identity.loggedIn = true;
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/treino');
    await expect(page.locator('app-training-page')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Voltar ao Início' })).toBeVisible();
  });
});

test.describe('convidado que tem a TV e o Treino', () => {
  test('o Treino não tem seta de voltar; os módulos se alternam pelos Ajustes', async ({
    context,
    page,
  }) => {
    await mockTvApi(context, identity);
    await installFakeEventSource(page);
    signInAsGuest(['module:tv', 'tv:control', 'module:training']);
    await openTraining(page, '/treino');

    // Só o botão redondo de configurações: nada de "Voltar à TV" nem de "Voltar ao Início".
    const header = page.locator('.training-header');
    await expect(header.getByRole('link')).toHaveCount(1);
    await expect(header.getByRole('link', { name: /^Voltar/ })).toHaveCount(0);
    await expect(header.locator('a[href="/tv"], a[href="/"]')).toHaveCount(0);
    await expect(gear(page)).toHaveAttribute('href', '/ajustes');

    // O controle continua sem seta de volta; a lista discreta dos módulos em Ajustes dá a troca.
    await gear(page).click();
    await expect(page).toHaveURL(/\/ajustes$/);
    // A seta do cabeçalho também leva a /tv; aqui se procura a linha da lista de módulos.
    const toTv = page.getByRole('link', { name: 'TV Controle da TV' });
    await expect(toTv).toHaveAttribute('href', '/tv');
    await toTv.click();
    await expect(page).toHaveURL(/\/tv$/);
  });

  test('quem só tem Treino não vê a troca de módulos', async ({ page }) => {
    await installFakeEventSource(page);
    signInAsGuest(TRAINING_ONLY);
    await openTraining(page, '/treino');

    await gear(page).click();
    await expect(page).toHaveURL(/\/ajustes$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Módulos' })).toHaveCount(0);
    await expect(page.locator('a[href="/tv"]')).toHaveCount(0);
  });
});

test.describe('convidado sem nenhum módulo liberado', () => {
  test('cai na Início só com os planejados e a Configurações, e nunca num módulo', async ({
    page,
  }, info) => {
    signInAsGuest([]);
    for (const path of ['/', '/treino', '/sem-acesso']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator('article.card h3')).toHaveText([
        'Controle do PC',
        'Rede da casa',
        'Backup de fotos',
      ]);
    }
    await expect(page.locator('article.card a')).toHaveCount(0);
    await expectSound(page, info, 'inicio-sem-modulo');
    await page.getByRole('link', { name: 'Configurações' }).click();
    await expect(page).toHaveURL(/\/ajustes$/);
    await page.getByRole('link', { name: /Perfil/ }).click();
    await expect(page).toHaveURL(/\/ajustes\/perfil$/);
  });

  test('"Sair" leva à tela de entrada', async ({ page }) => {
    signInAsGuest([]);
    await page.goto('/ajustes/perfil');
    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page).toHaveURL(/\/entrar$/);
  });
});
