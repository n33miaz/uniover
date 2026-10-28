import { Page } from '@playwright/test';
import { GUEST, IdentityMock, OWNER, OWNER_ID, mockIdentityApi } from '../auth/identity-mock';
import { expect, test } from '../fixtures';
import { seedExercise, seedTraining } from './support/training-seed';
import { beginWorkout, concludeSet, installClock } from './support/today-pages';
import { seedBenchHistory } from './support/today-seed';
import { chooseMuscle, countRows, trainingDbName } from './support/training-pages';
import { TrainingServer, mockTrainingApi } from './support/training-server';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/**
 * Duas contas no mesmo navegador (o dono testando como convidado, o convidado do Treino no aparelho que ele usa, um
 * aparelho emprestado): cada conta tem o próprio banco do Treino e a própria fila de escrita no aparelho, e nada de uma
 * aparece nem sai pela outra. O que está em jogo é uma série gravada sem rede por A ser enviada com o token de B.
 */

const GUEST_ID = '00000000-0000-4000-8000-000000000061';
const MINE = 'Remada articulada de A';

const OWNER_CATALOG = [
  seedExercise({
    n: 1,
    slug: 'supino-reto-com-barra',
    name: 'Supino reto com barra',
    primary: 'chest',
    equipment: 'barbell',
    instructions: ['Deite no banco.'],
  }),
  seedExercise({
    n: 5,
    slug: 'agachamento-livre-com-barra',
    name: 'Agachamento livre com barra',
    primary: 'quadriceps',
    equipment: 'barbell',
    instructions: ['Desça e suba.'],
  }),
];

const GUEST_CATALOG = [
  seedExercise({
    n: 7,
    slug: 'remada-sentada-na-polia',
    name: 'Remada sentada na polia',
    primary: 'middle_back',
    equipment: 'cable',
    instructions: ['Puxe o triângulo.'],
  }),
  seedExercise({
    n: 12,
    slug: 'prancha-isometrica',
    name: 'Prancha isométrica',
    primary: 'abdominals',
    equipment: 'bodyweight',
    recordType: 'time',
    instructions: ['Mantenha o corpo reto.'],
  }),
];

let identity: IdentityMock;
let server: TrainingServer;

test.beforeEach(async ({ context }) => {
  identity = await mockIdentityApi(context);
  server = await mockTrainingApi(context);
  server.seed('exercises', OWNER_CATALOG, OWNER_ID);
  server.seed('exercises', GUEST_CATALOG, GUEST_ID);
  // O convidado do Treino: só o módulo do Treino (como o Raphael).
  identity.guests.push({
    id: GUEST_ID,
    displayName: GUEST.displayName,
    email: GUEST.email,
    password: GUEST.password,
    createdAt: '2026-10-21T15:00:00Z',
    disabledAt: null,
    permissions: ['module:training'],
  });
});

const goOffline = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('offline')));
const goOnline = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('online')));

/** Entra pela tela de login (a conta que o formulário disser). */
async function signIn(page: Page, email: string, password: string) {
  await expect(page).toHaveURL(/\/entrar/);
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).not.toHaveURL(/\/entrar/);
}

/**
 * Navega dentro do app, pelo roteador, sem recarregar a página (o que prova que a troca de conta não depende de recarregar):
 * o roteador acompanha a barra de endereço como acompanha o botão "voltar" do navegador.
 */
async function goInApp(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

async function signOut(page: Page) {
  await goInApp(page, '/ajustes/perfil');
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page).toHaveURL(/\/entrar$/);
}

const exerciseNames = (page: Page) => page.locator('.list .name');

/** Quantos itens a fila de escrita de uma conta tem no aparelho; -1 se ela nem existe. */
function queued(page: Page, accountId: string): Promise<number> {
  return page.evaluate(async (name) => {
    const known = ((await indexedDB.databases()) ?? []).some((db) => db.name === name);
    if (!known) return -1;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const request = db.transaction('outbox').objectStore('outbox').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return count;
  }, `uniover-offline-${accountId}`);
}

/** Todo envio que chegou ao servidor (escrita), com a conta a quem o token pertencia. */
const writesAs = (account: string) =>
  server.hits.filter((hit) => hit.method === 'PUT' && hit.account === account);

/** A escrita de uma série (`sessions/<treino>/sets/<série>`). */
const isSetWrite = (hit: { method: string; path: string }) =>
  hit.method === 'PUT' && hit.path.includes('/sets/');

/** O dono entra, abre o Treino e grava um exercício próprio sem rede (a escrita fica só na fila do aparelho). */
async function ownerSavesOffline(page: Page) {
  await page.goto('/entrar');
  await page.evaluate(() => {
    (window as unknown as { sameDocument: boolean }).sameDocument = true;
  });
  await signIn(page, OWNER.email, OWNER.password);
  await goInApp(page, '/treino/exercicios');
  await expect(page.locator('app-training-page')).toBeVisible();
  await expect(exerciseNames(page)).toHaveText([
    'Agachamento livre com barra',
    'Supino reto com barra',
  ]);

  server.offline = true;
  await goOffline(page);
  await goInApp(page, '/treino/exercicios/novo');
  await page.getByLabel('Nome').fill(MINE);
  await chooseMuscle(page, 'Meio das costas');
  await page.getByRole('button', { name: 'Salvar Exercício' }).click();
  await expect(page.getByRole('heading', { name: MINE })).toBeVisible();
  await expect(page.getByText('1 ainda não sincronizado')).toBeVisible();
  expect(await queued(page, OWNER_ID)).toBe(1);
  expect(server.writes('exercises', OWNER_ID)).toBe(0);
}

test.describe('duas contas no mesmo navegador', () => {
  test('A grava sem rede e sai; B entra sem recarregar e não vê nada de A, nada sai como B; A volta e a escrita sai com o token de A', async ({
    page,
  }) => {
    await ownerSavesOffline(page);
    await signOut(page);

    // B entra com o servidor de volta: pode enviar e puxar. A fila de A não é dele.
    server.offline = false;
    await goOnline(page);
    await signIn(page, GUEST.email, GUEST.password);
    await goInApp(page, '/treino/exercicios');
    await expect(page.locator('app-training-page')).toBeVisible();
    await expect(exerciseNames(page)).toHaveText(['Prancha isométrica', 'Remada sentada na polia']);
    await expect(page.getByText(MINE)).toHaveCount(0);
    await expect(page.getByText('ainda não sincronizado')).toHaveCount(0);

    // B puxou (o motor dele passou por aqui), e mesmo assim nada de A saiu: nenhuma escrita com o token de B.
    expect(server.hits.some((hit) => hit.method === 'GET' && hit.account === GUEST_ID)).toBe(true);
    expect(writesAs(GUEST_ID)).toEqual([]);
    expect(server.hits.filter((hit) => hit.method === 'PUT')).toEqual([]);
    expect(await queued(page, GUEST_ID)).toBe(0);
    expect(await queued(page, OWNER_ID)).toBe(1);
    // Os bancos do Treino também são dois, e o de B não tem o que é de A.
    expect(await countRows(page, 'exercises', GUEST_ID)).toBe(2);
    expect(await countRows(page, 'exercises', OWNER_ID)).toBe(3);

    // B sai e A volta: vê o que é dele, e a escrita pendente sai com o token de A.
    await signOut(page);
    await signIn(page, OWNER.email, OWNER.password);
    await goInApp(page, '/treino/exercicios');
    await expect(exerciseNames(page)).toHaveText([
      'Agachamento livre com barra',
      MINE,
      'Supino reto com barra',
    ]);
    await expect.poll(() => server.writes('exercises', OWNER_ID)).toBe(1);
    await expect(page.getByText('ainda não sincronizado')).toHaveCount(0);

    const sent = server.hits.filter((hit) => hit.method === 'PUT');
    expect(sent.map((hit) => [hit.account, hit.outcome])).toEqual([[OWNER_ID, 'executed']]);
    expect(await queued(page, OWNER_ID)).toBe(0);
    expect(server.writes('exercises', GUEST_ID)).toBe(0);
    // Tudo isto sem recarregar a página nenhuma vez depois de abrir o app.
    expect(
      await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument),
    ).toBe(true);
  });

  test('A pendente, B entra com o servidor do Treino fora do ar e a rede volta: nada de A sai com o token de B', async ({
    page,
  }) => {
    await ownerSavesOffline(page);
    await signOut(page);

    // B entra enquanto o servidor do Treino ainda está fora: vê só o que é dele (nada, neste aparelho).
    await signIn(page, GUEST.email, GUEST.password);
    await goInApp(page, '/treino/exercicios');
    await expect(page.locator('app-training-page')).toBeVisible();
    await expect(exerciseNames(page)).toHaveCount(0);
    await expect(page.getByText(MINE)).toHaveCount(0);

    // A rede volta: o motor de B tenta, puxa o catálogo dele, e nada de A sai.
    server.offline = false;
    await goOnline(page);
    await expect(exerciseNames(page)).toHaveText(['Prancha isométrica', 'Remada sentada na polia']);

    expect(server.hits.filter((hit) => hit.method === 'PUT')).toEqual([]);
    expect(server.writes('exercises', OWNER_ID)).toBe(0);
    expect(await queued(page, OWNER_ID)).toBe(1);
    expect(await queued(page, GUEST_ID)).toBe(0);
  });
});

test.describe('o treino ao vivo de duas contas no mesmo navegador', () => {
  test('uma série gravada sem rede por A: B não vê o treino aberto nem a série aguardando envio, nada sai como B, e a série de A sai com o token de A', async ({
    page,
  }) => {
    await installClock(page);
    seedTraining(server); // catálogo e rotinas do dono (a conta padrão do servidor de teste)
    seedBenchHistory(server); // com a última vez do supino, a série já vem preenchida e basta concluir

    // A entra, começa o treino e conclui uma série sem rede: ela fica só no aparelho, esperando envio.
    await page.goto('/entrar');
    await signIn(page, OWNER.email, OWNER.password);
    await goInApp(page, '/treino');
    await expect(page.getByRole('heading', { name: 'Semana com Meta', exact: true })).toBeVisible();
    await expect(page.locator('.lines .ui-row').first()).toContainText('última vez 40 kg × 10');
    await beginWorkout(page);
    server.offline = true;
    await goOffline(page);
    await concludeSet(page);
    await expect(page.locator('.sending')).toContainText('1 série aguardando envio');
    expect(server.writes('sets', OWNER_ID)).toBe(0);
    await signOut(page);

    // B entra com o servidor de volta: a tela Hoje é a dele, sem o treino aberto de A nem o aviso de envio pendente.
    server.offline = false;
    await goOnline(page);
    await signIn(page, GUEST.email, GUEST.password);
    await goInApp(page, '/treino');
    await expect(page.getByText('Sem Rotinas Ainda')).toBeVisible();
    await expect(page.locator('app-week-calendar .week-days .day.done')).toHaveCount(0);
    await expect(page.getByText('Treino em Andamento')).toHaveCount(0);
    await expect(page.getByText('Continuar Treino')).toHaveCount(0);
    await expect(page.locator('.sending')).toHaveCount(0);
    await expect(page.getByText('ainda não sincronizado')).toHaveCount(0);
    // O motor de B passou por aqui (puxou o que é dele), e a série de A não saiu com o token de B.
    await expect
      .poll(() => server.hits.some((hit) => hit.method === 'GET' && hit.account === GUEST_ID))
      .toBe(true);
    expect(writesAs(GUEST_ID)).toEqual([]);
    expect(server.hits.filter(isSetWrite)).toEqual([]);
    expect(await queued(page, OWNER_ID)).toBe(1);
    expect(await queued(page, GUEST_ID)).toBe(0);

    // A volta: o treino aberto é dele, e a série pendente sai com o token de A.
    await signOut(page);
    await signIn(page, OWNER.email, OWNER.password);
    await goInApp(page, '/treino');
    await expect(page.getByText('Treino em Andamento')).toBeVisible();
    await expect(page.locator('app-week-calendar .week-days .day.done')).toHaveCount(1);
    await expect.poll(() => server.writes('sets', OWNER_ID), { timeout: 20_000 }).toBe(1);
    expect(server.writes('sets', GUEST_ID)).toBe(0);
    const sets = server.hits.filter(isSetWrite);
    expect(sets.map((hit) => [hit.account, hit.outcome])).toEqual([[OWNER_ID, 'executed']]);
    await expect.poll(() => queued(page, OWNER_ID)).toBe(0);
  });
});

test.describe('o que já existia no aparelho antes de haver um banco por conta', () => {
  const LEGACY_EXERCISE = 'Exercício do tempo antigo';
  const LEGACY_PENDING = '00000000-0000-4000-8000-0000000000aa';

  /** Planta os dois bancos antigos (sem conta), como o app os deixava: o catálogo do Treino e uma escrita pendente. */
  async function plantLegacy(page: Page) {
    await page.evaluate(
      async ({ exerciseName, pendingId }) => {
        const create = (name: string, stores: Record<string, string>) =>
          new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(name, 40);
            request.onupgradeneeded = () => {
              for (const [store, keyPath] of Object.entries(stores)) {
                request.result.createObjectStore(store, { keyPath });
              }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        const put = (db: IDBDatabase, store: string, row: unknown) =>
          new Promise<void>((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).put(row);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });

        const training = await create('uniover-training', {
          exercises: 'id',
          meta: 'key',
          syncState: 'resource',
          routines: 'id',
          sessions: 'id',
          sets: 'id',
          goals: 'id',
        });
        await put(training, 'exercises', {
          id: 'e-antigo',
          slug: 'e-antigo',
          source: 'own',
          sourceRef: null,
          name: exerciseName,
          nameKey: exerciseName.toLowerCase(),
          instructions: ['Faça o movimento.'],
          primaryMuscles: ['chest'],
          secondaryMuscles: [],
          equipment: 'barbell',
          recordType: 'weight_reps',
          stepKg: null,
          stepClientUpdatedAt: null,
          level: null,
          category: null,
          mechanic: null,
          license: null,
          licenseAuthor: null,
          licenseUrl: null,
          reviewed: true,
          updatedAt: 1,
          clientUpdatedAt: 1,
          deletedAt: null,
        });
        training.close();

        const offline = await create('uniover-offline', { outbox: 'id', meta: 'key' });
        await put(offline, 'outbox', {
          id: pendingId,
          method: 'PUT',
          url: `/api/v1/training/exercises/${pendingId}`,
          body: {
            name: 'Escrita pendente do tempo antigo',
            clientUpdatedAt: new Date().toISOString(),
          },
          module: 'training',
          createdAt: Date.now(),
          attempts: 0,
          nextAttemptAt: 0,
          status: 'pending',
          lastError: null,
          revision: 0,
        });
        offline.close();
      },
      { exerciseName: LEGACY_EXERCISE, pendingId: LEGACY_PENDING },
    );
  }

  test('a primeira conta que entra adota o banco antigo e a escrita pendente (que sai com o token dela); a segunda começa vazia', async ({
    page,
  }) => {
    server.offline = true;
    await page.goto('/entrar');
    await plantLegacy(page);

    await signIn(page, OWNER.email, OWNER.password);
    await goInApp(page, '/treino/exercicios');
    // Sem rede para o servidor do Treino: o que aparece veio do banco antigo, copiado para o da conta.
    await expect(exerciseNames(page)).toHaveText([LEGACY_EXERCISE]);
    await expect.poll(() => countRows(page, 'exercises', OWNER_ID)).toBe(1);
    await expect.poll(() => queued(page, OWNER_ID)).toBe(1);

    // A rede volta: a escrita que estava pendente no banco antigo sai uma vez, com o token do dono.
    server.offline = false;
    await goOnline(page);
    await expect.poll(() => server.writes('exercises', OWNER_ID)).toBe(1);
    // As tentativas de antes (com o servidor fora do ar) não contam: só uma executou, e com a chave de sempre.
    const executed = writesAs(OWNER_ID).filter((hit) => hit.outcome === 'executed');
    expect(executed.map((hit) => hit.key)).toEqual([LEGACY_PENDING]);
    await expect.poll(() => queued(page, OWNER_ID)).toBe(0);

    // A segunda conta no mesmo navegador não herda nada do que era do dono.
    await signOut(page);
    await signIn(page, GUEST.email, GUEST.password);
    await goInApp(page, '/treino/exercicios');
    await expect(exerciseNames(page)).toHaveText(['Prancha isométrica', 'Remada sentada na polia']);
    await expect(page.getByText(LEGACY_EXERCISE)).toHaveCount(0);
    expect(await queued(page, GUEST_ID)).toBe(0);
    expect(writesAs(GUEST_ID)).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('uniover.legacy-owner'))).toBe(OWNER_ID);
    expect(trainingDbName(GUEST_ID)).not.toBe(trainingDbName(OWNER_ID));
  });
});
