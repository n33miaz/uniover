import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Page, TestInfo } from '@playwright/test';
import { GUEST, IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { settle, smallTargets } from '../screens/screen-helpers';
import { TrainingServer, mockTrainingApi } from './support/training-server';
import { seedTraining } from './support/training-seed';
import { chooseMuscle, openTraining, trainingDbName } from './support/training-pages';
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
  test('aceita o convite, escolhe o nome e abre direto no Treino, sem passar pela TV', async ({
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

    await expect(page).toHaveURL(/\/treino$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Treino' })).toBeVisible();
    await expect(page.locator('app-training-page')).toBeVisible();

    // No lugar da seta de voltar ao Início (que ele não tem), o botão redondo de configurações, como na TV.
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

  test('os Ajustes dele voltam para o Treino, não para a TV', async ({ page }, info) => {
    signInAsGuest(TRAINING_ONLY);
    await page.goto('/treino');
    await expect(page.getByRole('heading', { level: 1, name: 'Treino' })).toBeVisible();
    for (const scheme of ['light', 'dark'] as const) {
      await useScheme(page, scheme);
      await shot(page, info, 'treino-so-treino', scheme);
    }
    await gear(page).click();
    await expect(page).toHaveURL(/\/ajustes$/);
    const back = page.getByRole('link', { name: 'Voltar ao Treino' });
    await expect(back).toHaveAttribute('href', '/treino');
    await expect(page.getByRole('link', { name: 'Voltar ao controle' })).toHaveCount(0);
    await back.click();
    await expect(page).toHaveURL(/\/treino$/);
    expect(tvRequests).toEqual([]);
  });

  test('o endereço de início, o do atalho e as telas só do dono levam ao Treino', async ({
    page,
  }) => {
    signInAsGuest(TRAINING_ONLY);
    for (const path of ['/', '/ajustes/seguranca', '/nada-aqui']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/treino$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Treino' })).toBeVisible();
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

  test('quem só tem a TV não entra no Treino: vai para o controle', async ({ context, page }) => {
    await mockTvApi(context, identity);
    await installFakeEventSource(page);
    signInAsGuest(['module:tv', 'tv:control']);
    await page.goto('/treino');
    await expect(page).toHaveURL(/\/tv$/);
    await expect(page.locator('app-training-page')).toHaveCount(0);
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

test.describe('convidado sem nenhum módulo liberado', () => {
  test('cai numa tela simples, com Perfil e Sair, e nunca num módulo', async ({ page }, info) => {
    signInAsGuest([]);
    await page.goto('/');
    await expect(page).toHaveURL(/\/sem-acesso$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sem acesso' })).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Nada liberado por enquanto' }),
    ).toBeVisible();
    await page.goto('/treino');
    await expect(page).toHaveURL(/\/sem-acesso$/);
    await page.goto('/sem-acesso');
    await expect(page.getByRole('heading', { level: 1, name: 'Sem acesso' })).toBeVisible();
    await expectSound(page, info, 'sem-acesso');
    await page.getByRole('link', { name: 'Ver meu perfil' }).click();
    await expect(page).toHaveURL(/\/ajustes\/perfil$/);
  });

  test('"Sair" leva à tela de entrada', async ({ page }) => {
    signInAsGuest([]);
    await page.goto('/sem-acesso');
    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page).toHaveURL(/\/entrar$/);
  });
});

/**
 * O que só vale no iPhone (Safari fora da tela de início). O projeto `iphone-12` já traz o agente do Safari do iPhone; o
 * Chromium do Android não é iOS e fica de fora.
 */
test.describe('iPhone, Safari fora da tela de início', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'webkit', 'só o iPhone (WebKit) tem este caso');
  });

  test.describe('a folha de instalação, ligada', () => {
    test.use({ installHintSilenced: false });

    test('abre uma vez na primeira entrada, com o passo a passo, e "Agora não" é lembrado', async ({
      page,
    }, info) => {
      test.setTimeout(75_000);
      signInAsGuest(TRAINING_ONLY);
      await page.goto('/treino');
      await expect(page.locator('app-training-page')).toBeVisible();

      // Nunca durante o carregamento; uns 3 s depois da tela pronta, sim.
      await expect(sheetOf(page)).toHaveCount(0);
      const sheet = sheetOf(page);
      await expect(sheet).toBeVisible({ timeout: 10_000 });
      await expect(sheet.getByRole('listitem')).toHaveCount(3);
      await expect(sheet.getByRole('button', { name: 'Agora não' })).toBeFocused();
      await expectSound(page, info, 'folha-instalar', 'dialog[open]');

      await sheet.getByRole('button', { name: 'Agora não' }).click();
      await expect(sheetOf(page)).toHaveCount(0);
      const memory = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('uniover.install-hint.v1') ?? 'null'),
      );
      expect(typeof memory?.dismissedAt).toBe('number');

      // Dispensada, não volta ao recarregar (só depois de 14 dias).
      await page.reload();
      await expect(page.locator('app-training-page')).toBeVisible();
      await page.waitForTimeout(AFTER_DELAY_MS);
      await expect(sheetOf(page)).toHaveCount(0);
      expect(tvRequests).toEqual([]);
    });

    test('com um treino aberto neste aparelho, a folha não abre sozinha; sem ele, abre', async ({
      page,
    }) => {
      test.setTimeout(75_000);
      signInAsGuest(TRAINING_ONLY);
      await page.goto('/treino');
      await expect(page.locator('app-training-page')).toBeVisible();
      await expect(sheetOf(page)).toBeVisible({ timeout: 10_000 });
      await sheetOf(page).getByRole('button', { name: 'Agora não' }).click();
      // O "Agora não" adia por 14 dias: o teste apaga a memória para provar só o efeito do treino aberto.
      await page.evaluate(() => localStorage.removeItem('uniover.install-hint.v1'));

      // Deixa o banco do Treino pronto e planta um treino aberto neste aparelho (como o app restaurado no meio da série).
      await expect
        .poll(() =>
          page.evaluate(
            async (name) => ((await indexedDB.databases()) ?? []).some((db) => db.name === name),
            trainingDbName(GUEST_ID),
          ),
        )
        .toBe(true);
      await plantOpenWorkout(page, trainingDbName(GUEST_ID));

      await page.reload();
      await expect(page.locator('app-training-page')).toBeVisible();
      await page.waitForTimeout(AFTER_DELAY_MS);
      await expect(sheetOf(page)).toHaveCount(0);

      // O mesmo aparelho, agora sem treino aberto: a folha abre.
      await removeOpenWorkout(page, trainingDbName(GUEST_ID));
      await page.reload();
      await expect(page.locator('app-training-page')).toBeVisible();
      await expect(sheetOf(page)).toBeVisible({ timeout: 10_000 });
    });
  });

  test.describe('treino sem enviar e sem rede', () => {
    const goOffline = (page: Page) =>
      page.evaluate(() => window.dispatchEvent(new Event('offline')));
    const goOnline = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('online')));

    /** Cria um exercício próprio sem rede: fica na fila do aparelho, "1 ainda não sincronizado". */
    async function createWhileOffline(page: Page) {
      server.offline = true;
      await goOffline(page);
      await page.getByLabel('Nome').fill('Remada na máquina articulada');
      await chooseMuscle(page, 'Meio das costas');
      await page.getByRole('button', { name: 'Salvar exercício' }).click();
      await expect(
        page.getByRole('heading', { name: 'Remada na máquina articulada' }),
      ).toBeVisible();
    }

    test('sem nada para enviar não aparece nada, mesmo sem rede', async ({ page }) => {
      signInAsGuest(TRAINING_ONLY);
      await openTraining(page, '/treino/exercicios');
      server.offline = true;
      await goOffline(page);
      await expect(page.getByText('Sem rede: usando o que está no aparelho')).toBeVisible();
      await expect(advice(page)).toHaveCount(0);
    });

    test('com treino parado no aparelho, a linha sugere instalar e leva ao passo a passo', async ({
      page,
    }, info) => {
      test.setTimeout(75_000);
      signInAsGuest(TRAINING_ONLY);
      await openTraining(page, '/treino/exercicios/novo');
      await createWhileOffline(page);
      await expect(page.getByText('1 ainda não sincronizado')).toBeVisible();

      const suggestion = advice(page);
      await expect(suggestion).toBeVisible();
      await expect(suggestion).toContainText(
        'Estes treinos estão salvos só neste navegador. Envie-os quando tiver internet; instale na tela de início para os próximos.',
      );
      // Um aviso na linha, sem tirar a tela do lugar: nenhum botão novo permanente, só este, e só agora.
      await expectSound(page, info, 'linha-instalar', undefined);

      await suggestion.click();
      const sheet = sheetOf(page);
      await expect(sheet).toBeVisible();
      // Aberta por ele (e não sozinha): só "Fechar", sem "Não mostrar de novo".
      await expect(sheet.getByRole('button', { name: 'Fechar' })).toBeVisible();
      await expect(sheet.getByRole('button', { name: 'Não mostrar de novo' })).toHaveCount(0);
      await expectSound(page, info, 'linha-instalar-aberta', 'dialog[open]');
      await sheet.getByRole('button', { name: 'Fechar' }).click();
      await expect(sheetOf(page)).toHaveCount(0);
      // O foco de volta ao botão só se confere no Chromium (o Safari não dá foco a botão tocado): ver install-hint.spec.

      // A rede volta, o treino sobe e o aviso some.
      server.offline = false;
      await goOnline(page);
      // O servidor guarda por conta: a escrita é do convidado deste teste.
      await expect.poll(() => server.writes('exercises', GUEST_ID)).toBe(1);
      await expect(page.getByText('ainda não sincronizado')).toHaveCount(0);
      await expect(advice(page)).toHaveCount(0);
    });

    test('no app já instalado (aberto pela tela de início) o aviso não aparece', async ({
      page,
    }) => {
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'standalone', {
          get: () => true,
          configurable: true,
        });
      });
      signInAsGuest(TRAINING_ONLY);
      await openTraining(page, '/treino/exercicios/novo');
      await createWhileOffline(page);
      await expect(page.getByText('1 ainda não sincronizado')).toBeVisible();
      await expect(advice(page)).toHaveCount(0);
    });
  });
});

/**
 * Planta no banco local um treino aberto deste aparelho: a linha do treino e os dois ponteiros (o do aparelho e o do treino
 * ativo). É o que o app deixa no meio de uma série; recarregar a página o restaura.
 */
async function plantOpenWorkout(page: Page, dbName: string) {
  await page.evaluate(
    (dbName) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(dbName);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const now = Date.now();
          const tx = db.transaction(['sessions', 'meta'], 'readwrite');
          tx.objectStore('meta').put({ key: 'deviceId', value: 'aparelho-do-teste' });
          tx.objectStore('meta').put({ key: 'activeSessionId', value: 'treino-aberto' });
          tx.objectStore('sessions').put({
            id: 'treino-aberto',
            routineId: null,
            startedAt: now,
            finishedAt: null,
            note: '',
            feeling: null,
            deviceId: 'aparelho-do-teste',
            updatedAt: now,
            clientUpdatedAt: now,
            deletedAt: null,
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    dbName,
  );
}

async function removeOpenWorkout(page: Page, dbName: string) {
  await page.evaluate(
    (dbName) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(dbName);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['sessions', 'meta'], 'readwrite');
          tx.objectStore('meta').delete('activeSessionId');
          tx.objectStore('sessions').delete('treino-aberto');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    dbName,
  );
}
