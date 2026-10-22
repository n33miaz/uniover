import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Page, TestInfo } from '@playwright/test';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { dropConnection, failWith, gateScripts, pressKeyWithCapsLock } from './entry-helpers';
import { GUEST, IdentityMock, OWNER, mockIdentityApi } from './identity-mock';

// Prints de todas as telas e estados de entrada e convite, para conferir o visual. Só rodam quando a pasta de
// saída é informada (`AUTH_SHOTS_DIR`): na esteira não geram nada. Cada combinação de tema e orientação é um
// teste pequeno, porque o WebKit do Linux é bem mais lento que o do Windows.
const OUT = process.env['AUTH_SHOTS_DIR'];
test.skip(!OUT, 'prints só rodam com AUTH_SHOTS_DIR');

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const SCHEMES = ['light', 'dark'] as const;
const ORIENTATIONS = { retrato: null, paisagem: { width: 844, height: 390 } } as const;

type Scheme = (typeof SCHEMES)[number];
type Orientation = keyof typeof ORIENTATIONS;

let mock: IdentityMock;

test.beforeEach(async ({ context }) => {
  mock = await mockIdentityApi(context);
});

/** Print da página inteira (o que cabe e o que rola), nomeado pelo estado, tema e orientação. */
async function shoot(
  page: Page,
  info: TestInfo,
  state: string,
  scheme: Scheme,
  orient: Orientation,
) {
  const dir = join(OUT!, info.project.name);
  mkdirSync(dir, { recursive: true });
  await expectNoHorizontalScroll(page);
  // As transições curtas dos campos (borda, contorno) terminam antes do print.
  await page.waitForTimeout(300);
  await screenshot(page, join(dir, `${state}-${scheme}-${orient}.png`), { fullPage: true });
}

/** Tema, orientação e movimento reduzido (para o print não pegar uma entrada no meio). */
async function prepare(page: Page, scheme: Scheme, orient: Orientation) {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  const size = ORIENTATIONS[orient];
  if (size) await page.setViewportSize(size);
}

const secretLink = '/convite#' + 'a'.repeat(43);
const STRONG = 'Uma-senha-bem-longa-9!';

async function openLogin(page: Page) {
  await page.goto('/entrar');
  await expect(page.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
}

async function openInvite(page: Page, link = secretLink) {
  await page.goto(link);
}

/** Abre o convite de novo do zero (a tela de entrada no meio garante outra instância da tela, sem espera correndo). */
async function reopenInvite(page: Page, link = secretLink) {
  await page.goto('/entrar');
  await openInvite(page, link);
}

async function fillInvite(page: Page, password = STRONG, confirmation = password) {
  await page.getByLabel('E-mail').fill(GUEST.email);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByLabel('Repita a senha').fill(confirmation);
}

const submitLogin = (page: Page) => page.getByRole('button', { name: 'Entrar', exact: true });
const submitInvite = (page: Page) => page.getByRole('button', { name: 'Continuar', exact: true });

for (const scheme of SCHEMES) {
  for (const orient of Object.keys(ORIENTATIONS) as Orientation[]) {
    test.describe(`prints ${scheme} ${orient}`, () => {
      test.beforeEach(async ({ page }) => prepare(page, scheme, orient));

      test('entrar: vazio, preenchido, Caps Lock e validação', async ({ page }, info) => {
        await openLogin(page);
        await shoot(page, info, 'entrar-vazio', scheme, orient);

        await page.getByLabel('E-mail').fill(OWNER.email);
        await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
        await page.getByRole('button', { name: 'Mostrar senha' }).click();
        await shoot(page, info, 'entrar-preenchido-senha-visivel', scheme, orient);

        await page.getByRole('button', { name: 'Mostrar senha' }).click();
        await pressKeyWithCapsLock(page.getByLabel('Senha', { exact: true }), true);
        await expect(page.getByText('Caps Lock ligado')).toBeVisible();
        await shoot(page, info, 'entrar-caps-lock', scheme, orient);

        await page.reload();
        await submitLogin(page).click();
        await expect(page.getByText('Informe o seu e-mail.')).toBeVisible();
        await shoot(page, info, 'entrar-validacao', scheme, orient);
      });

      test('entrar: enviando e erros por tipo', async ({ page }, info) => {
        await openLogin(page);
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        await page.route('**/api/v1/identity/auth/login', async (route) => {
          await held;
          await route.fulfill({ status: 401, body: '{}', contentType: 'application/problem+json' });
        });
        await page.getByLabel('E-mail').fill(OWNER.email);
        await page.getByLabel('Senha', { exact: true }).fill('senha-errada');
        await submitLogin(page).click();
        await expect(page.getByRole('button', { name: 'Entrando…' })).toBeVisible();
        await shoot(page, info, 'entrar-enviando', scheme, orient);
        release();
        await expect(page.getByRole('alert')).toContainText('E-mail ou senha incorretos.');
        await shoot(page, info, 'entrar-erro-credenciais', scheme, orient);
      });

      test('entrar: bloqueio, limite, sem rede e falha do servidor', async ({ page }, info) => {
        await openLogin(page);
        await page.getByLabel('E-mail').fill(OWNER.email);
        await page.getByLabel('Senha', { exact: true }).fill('qualquer-coisa');

        await failWith(page, '/auth/login', 429, 'login-locked', { 'retry-after': '125' });
        await submitLogin(page).click();
        await expect(page.getByRole('alert')).toContainText('Conta bloqueada');
        await shoot(page, info, 'entrar-bloqueada', scheme, orient);

        await page.unroute('**/api/v1/identity/auth/login');
        await page.reload();
        await page.getByLabel('E-mail').fill(OWNER.email);
        await page.getByLabel('Senha', { exact: true }).fill('qualquer-coisa');
        await failWith(page, '/auth/login', 429, 'rate-limited', { 'retry-after': '30' });
        await submitLogin(page).click();
        await expect(page.getByRole('alert')).toContainText('Muitas tentativas');
        await shoot(page, info, 'entrar-limite', scheme, orient);

        await page.unroute('**/api/v1/identity/auth/login');
        await page.reload();
        await page.getByLabel('E-mail').fill(OWNER.email);
        await page.getByLabel('Senha', { exact: true }).fill('qualquer-coisa');
        await dropConnection(page, '/auth/login');
        await submitLogin(page).click();
        await expect(page.getByRole('alert')).toContainText('Sem conexão');
        await shoot(page, info, 'entrar-sem-rede', scheme, orient);

        await page.unroute('**/api/v1/identity/auth/login');
        await failWith(page, '/auth/login', 500, 'internal');
        await submitLogin(page).click();
        await expect(page.getByRole('alert')).toContainText('Não foi possível entrar agora');
        await shoot(page, info, 'entrar-falha-servidor', scheme, orient);
      });

      test('entrar: a espera acaba e a faixa vira "pronto"', async ({ page }, info) => {
        await openLogin(page);
        await page.getByLabel('E-mail').fill('bloqueado@exemplo.com');
        await page.getByLabel('Senha', { exact: true }).fill('qualquer-coisa');
        await submitLogin(page).click();
        await expect(page.getByRole('status').filter({ hasText: 'Pronto' })).toBeVisible({
          timeout: 8_000,
        });
        await shoot(page, info, 'entrar-espera-acabou', scheme, orient);
      });

      test('convite: formulário vazio, senha fraca, boa e divergente', async ({ page }, info) => {
        await openInvite(page);
        await expect(
          page.getByRole('heading', { level: 1, name: 'Criar conta', exact: true }),
        ).toBeVisible();
        await shoot(page, info, 'convite-vazio', scheme, orient);

        await page.getByLabel('E-mail').fill('ana');
        await page.getByLabel('Senha', { exact: true }).fill('curta1');
        await page.getByLabel('Repita a senha').fill('curta');
        await page.getByLabel('Repita a senha').blur();
        await expect(page.getByText('Confira o e-mail')).toBeVisible();
        await shoot(page, info, 'convite-senha-curta-divergente', scheme, orient);

        await page.getByLabel('E-mail').fill(GUEST.email);
        await page.getByLabel('Senha', { exact: true }).fill(STRONG);
        await page.getByLabel('Repita a senha').fill(STRONG);
        await page.getByRole('button', { name: 'Mostrar senha', exact: true }).click();
        await expect(page.getByText('As senhas conferem.', { exact: true })).toBeVisible();
        await shoot(page, info, 'convite-senha-forte-conferem', scheme, orient);
      });

      test('convite: recusas antes e depois do servidor', async ({ page }, info) => {
        const invite = mock.seedInvite();
        await openInvite(page, `/convite#${invite.token}`);
        await page.getByLabel('E-mail').fill(GUEST.email);
        await page.getByLabel('Senha', { exact: true }).fill('curta1');
        await page.getByLabel('Repita a senha').fill('curta1');
        await submitInvite(page).click();
        await expect(page.getByRole('alert')).toContainText('ao menos 10 caracteres');
        await shoot(page, info, 'convite-erro-senha-curta', scheme, orient);

        await fillInvite(page, STRONG, 'Outra-senha-longa-1!');
        await submitInvite(page).click();
        await expect(page.locator('#invite-confirmation-status')).toHaveText(
          'As senhas ainda não são iguais.',
        );
        await shoot(page, info, 'convite-erro-divergente', scheme, orient);

        await fillInvite(page);
        await page.getByLabel('E-mail').fill(OWNER.email);
        await submitInvite(page).click();
        await expect(page.getByRole('alert')).toContainText('Este e-mail não pode ser usado');
        await expect(page.getByLabel('E-mail')).toBeFocused();
        await shoot(page, info, 'convite-erro-email-em-uso', scheme, orient);
      });

      test('convite: limite de tentativas, sem rede e falha do servidor', async ({
        page,
      }, info) => {
        await openInvite(page);
        await fillInvite(page);

        await failWith(page, '/guest-invites/accept', 429, 'rate-limited', { 'retry-after': '48' });
        await submitInvite(page).click();
        await expect(page.getByRole('alert')).toContainText('Muitas tentativas');
        await shoot(page, info, 'convite-limite', scheme, orient);

        await page.unroute('**/api/v1/identity/guest-invites/accept');
        await reopenInvite(page);
        await fillInvite(page);
        await dropConnection(page, '/guest-invites/accept');
        await submitInvite(page).click();
        await expect(page.getByRole('alert')).toContainText('Sem conexão');
        await shoot(page, info, 'convite-sem-rede', scheme, orient);

        await page.unroute('**/api/v1/identity/guest-invites/accept');
        await reopenInvite(page);
        await fillInvite(page);
        await failWith(page, '/guest-invites/accept', 500, 'internal');
        await submitInvite(page).click();
        await expect(page.getByRole('alert')).toContainText('Não foi possível criar a conta agora');
        await shoot(page, info, 'convite-falha-servidor', scheme, orient);
      });

      test('convite: não vale mais, sem link e link incompleto', async ({ page }, info) => {
        await openInvite(page);
        await fillInvite(page);
        await submitInvite(page).click();
        await expect(page.getByRole('alert')).toContainText('Este convite não vale mais');
        await shoot(page, info, 'convite-nao-vale-mais', scheme, orient);

        await page.goto('/convite');
        await expect(page.getByRole('alert')).toContainText('Abra o link do convite');
        await shoot(page, info, 'convite-sem-link', scheme, orient);

        await page.goto('/convite#curto');
        await expect(page.getByRole('alert')).toContainText('incompleto');
        await shoot(page, info, 'convite-link-incompleto', scheme, orient);
      });

      test('convite: tudo pronto', async ({ page }, info) => {
        const invite = mock.seedInvite();
        // A tela seguinte fica retida: o "tudo pronto" permanece na tela até o print terminar.
        const gate = await gateScripts(page);
        await openInvite(page, `/convite#${invite.token}`);
        await expect(
          page.getByRole('heading', { level: 1, name: 'Criar conta', exact: true }),
        ).toBeVisible();
        gate.hold();
        await fillInvite(page);
        await submitInvite(page).click();
        await expect(page.getByRole('heading', { level: 1, name: 'Tudo pronto' })).toBeVisible();
        await shoot(page, info, 'convite-tudo-pronto', scheme, orient);
        gate.release();
      });

      test('teclado virtual simulado (janela baixa)', async ({ page }, info) => {
        await openLogin(page);
        await page.getByLabel('Senha', { exact: true }).focus();
        const small = ORIENTATIONS[orient]
          ? { width: 844, height: 200 }
          : { width: 390, height: 330 };
        await page.setViewportSize(small);
        await expect(page.getByLabel('Senha', { exact: true })).toBeInViewport();
        const dir = join(OUT!, info.project.name);
        mkdirSync(dir, { recursive: true });
        await screenshot(page, join(dir, `entrar-teclado-${scheme}-${orient}.png`));
      });
    });
  }
}
