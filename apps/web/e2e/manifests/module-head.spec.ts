import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Page } from '@playwright/test';
import { GUEST, IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, test } from '../fixtures';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const publicDir = join(__dirname, '..', '..', 'public');

interface Scope {
  manifest: string;
  touchIcon: string;
  /** O `name` do manifest do escopo: é o que o iOS grava ao "Adicionar à Tela de Início". */
  name: string;
}

/** Lê o nome do manifest em disco: se o nome do código e o do manifest se afastarem, o teste falha. */
function scopeOf(slug?: string): Scope {
  const prefix = slug ? `/${slug}` : '';
  const manifest = JSON.parse(
    readFileSync(join(publicDir, slug ?? '', 'manifest.webmanifest'), 'utf8'),
  ) as { name: string };
  return {
    manifest: `${prefix}/manifest.webmanifest`,
    touchIcon: `${prefix}/apple-touch-icon.png`,
    name: manifest.name,
  };
}

const ROOT = scopeOf();
const TV = scopeOf('tv');
const TRAINING = scopeOf('treino');

let identity: IdentityMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  await mockTvApi(context, identity);
  await installFakeEventSource(page);
});

/** Um único manifest, um único ícone e o nome do app, todos do escopo (repete até o app terminar de navegar). */
async function expectHead(page: Page, scope: Scope) {
  await expect(page).toHaveTitle(scope.name);
  const manifest = page.locator('head link[rel="manifest"]');
  await expect(manifest).toHaveCount(1);
  await expect(manifest).toHaveAttribute('href', scope.manifest);
  const touchIcon = page.locator('head link[rel="apple-touch-icon"]');
  await expect(touchIcon).toHaveCount(1);
  await expect(touchIcon).toHaveAttribute('href', scope.touchIcon);
  const appName = page.locator('head meta[name="apple-mobile-web-app-title"]');
  await expect(appName).toHaveCount(1);
  await expect(appName).toHaveAttribute('content', scope.name);
}

/** O que o head aponta tem de existir: manifest e ícone respondem 200 com o tipo certo. */
async function expectTargetsRespond(page: Page) {
  const manifestHref = await page.locator('head link[rel="manifest"]').getAttribute('href');
  const touchHref = await page.locator('head link[rel="apple-touch-icon"]').getAttribute('href');
  const manifest = await page.request.get(manifestHref!);
  expect(manifest.status(), manifestHref!).toBe(200);
  expect(manifest.headers()['content-type'], manifestHref!).toContain('application/manifest+json');
  const icon = await page.request.get(touchHref!);
  expect(icon.status(), touchHref!).toBe(200);
  expect(icon.headers()['content-type'], touchHref!).toBe('image/png');
}

type MarkedWindow = Window & { sameDocument?: boolean };

/**
 * Marca o documento aberto. Qualquer carga nova (`goto`, recarga) faria o servidor entregar o head certo sozinho e o
 * teste passaria sem o código do app; a marca só sobrevive se a navegação foi do roteador, dentro do mesmo documento.
 */
async function markDocument(page: Page) {
  await page.evaluate(() => {
    (window as MarkedWindow).sameDocument = true;
  });
}

async function expectSameDocument(page: Page) {
  expect(await page.evaluate(() => (window as MarkedWindow).sameDocument)).toBe(true);
}

test.describe('head por módulo no cliente', () => {
  test('do Início para a TV e o Treino e de volta, sem recarregar, o head acompanha o módulo', async ({
    page,
  }) => {
    identity.loggedIn = true;
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Bom dia|Boa tarde|Boa noite/);
    await expectHead(page, ROOT);
    await markDocument(page);

    await page.getByRole('link', { name: 'Abrir controle' }).click();
    await expect(page).toHaveURL(/\/tv$/);
    await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
    await expectHead(page, TV);
    await expectTargetsRespond(page);
    await expectSameDocument(page);

    await page.getByRole('link', { name: /Início/ }).click();
    await expect(page).toHaveURL(/\/$/);
    await expectHead(page, ROOT);
    await expectTargetsRespond(page);

    await page.getByRole('link', { name: 'Ver treino' }).click();
    await expect(page).toHaveURL(/\/treino$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Treino' })).toBeVisible();
    await expectHead(page, TRAINING);
    await expectTargetsRespond(page);

    await page.getByRole('link', { name: 'Voltar ao Início' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expectHead(page, ROOT);
    await expectSameDocument(page);
  });

  test('carga direta de /tv/ já abre com o título e o nome da TV, e um único de cada elemento', async ({
    page,
  }) => {
    identity.loggedIn = true;
    await page.goto('/tv/');
    await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
    await expectHead(page, TV);
    await expectTargetsRespond(page);
  });

  test('convidada: o convite abre na raiz e, ao cair na /tv sem recarregar, o head é o da TV', async ({
    page,
  }) => {
    const invite = identity.seedInvite();
    await page.goto(`/convite#${invite.token}`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Criar conta', exact: true }),
    ).toBeVisible();
    await expectHead(page, ROOT);
    await markDocument(page);

    await page.getByLabel('E-mail').fill(GUEST.email);
    await page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
    await page.getByLabel('Repita a senha').fill(GUEST.password);
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();

    await expect(page).toHaveURL(/\/tv$/);
    await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
    await expectHead(page, TV);
    await expectTargetsRespond(page);
    await expectSameDocument(page);
  });
});
