import { BrowserContext, Page } from '@playwright/test';
import { OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, test } from '../fixtures';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const DATABASE = 'uniover-offline';

/**
 * `up`: aceita · `down`: a rede não entrega · `waking`: o Render ainda está acordando (503 com o cabeçalho de
 * roteamento) · `lose-response`: o servidor grava mas a resposta se perde no caminho.
 */
type Mode = 'up' | 'down' | 'waking' | 'lose-response';

interface OrdersServer {
  mode: Mode;
  /** Quantas vezes o manipulador de cada chave executou de verdade (o que gravaria no banco). */
  readonly executions: Map<string, number>;
  /** Resposta guardada por chave: é o que um servidor idempotente devolve no reenvio. */
  readonly stored: Map<string, { status: number; body: string }>;
  /** Toda requisição que chegou, em ordem, com a chave e o que o servidor respondeu. */
  readonly hits: { key: string; outcome: string }[];
}

/** Servidor idempotente por chave, feito de rotas do Playwright. */
async function mockOrdersApi(context: BrowserContext): Promise<OrdersServer> {
  const server: OrdersServer = {
    mode: 'up',
    executions: new Map(),
    stored: new Map(),
    hits: [],
  };

  await context.route('**/api/test/orders', async (route) => {
    const request = route.request();
    const key = request.headers()['idempotency-key'] ?? '';
    const hit = (outcome: string) => server.hits.push({ key, outcome });

    if (server.mode === 'down') {
      hit('down');
      return route.abort('internetdisconnected');
    }
    if (server.mode === 'waking') {
      hit('waking');
      return route.fulfill({
        status: 503,
        headers: { 'x-render-routing': 'hibernate-wake' },
        body: '',
      });
    }
    if (
      request.method() !== 'POST' ||
      !key ||
      request.headers()['content-type'] !== 'application/json'
    ) {
      hit('invalid');
      return route.fulfill({ status: 400, body: '' });
    }

    const previous = server.stored.get(key);
    if (previous) {
      hit('replayed');
      return route.fulfill({
        status: previous.status,
        headers: { 'content-type': 'application/json', 'idempotent-replayed': 'true' },
        body: previous.body,
      });
    }

    server.executions.set(key, (server.executions.get(key) ?? 0) + 1);
    const body = JSON.stringify({ id: key });
    server.stored.set(key, { status: 201, body });
    if (server.mode === 'lose-response') {
      hit('executed-response-lost');
      return route.abort('connectionreset');
    }
    hit('executed');
    return route.fulfill({
      status: 201,
      headers: { 'content-type': 'application/json' },
      body,
    });
  });

  return server;
}

async function signIn(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/entrar$/);
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  // O motor hidrata o banco na partida do app: o banco da fila passa a existir.
  await expect
    .poll(() =>
      page.evaluate(
        async (name) => ((await indexedDB.databases()) ?? []).some((db) => db.name === name),
        DATABASE,
      ),
    )
    .toBe(true);
}

/** Grava itens direto no IndexedDB da fila, como se um módulo tivesse enfileirado enquanto estava sem rede. */
async function insertQueued(page: Page, count: number): Promise<string[]> {
  return page.evaluate(
    async ({ name, count }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const ids: string[] = [];
      const base = Date.now();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('outbox', 'readwrite');
        for (let i = 0; i < count; i++) {
          const id = crypto.randomUUID();
          ids.push(id);
          tx.objectStore('outbox').add({
            id,
            method: 'POST',
            url: '/api/test/orders',
            body: { n: i + 1 },
            module: 'e2e',
            createdAt: base + i,
            attempts: 0,
            nextAttemptAt: 0,
            status: 'pending',
            lastError: null,
            revision: 0,
          });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return ids;
    },
    { name: DATABASE, count },
  );
}

async function queuedIds(page: Page): Promise<string[]> {
  return page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<{ id: string; createdAt: number }[]>((resolve) => {
      const request = db.transaction('outbox').objectStore('outbox').getAll();
      request.onsuccess = () => resolve(request.result as { id: string; createdAt: number }[]);
    });
    db.close();
    return rows.sort((a, b) => a.createdAt - b.createdAt).map((row) => row.id);
  }, DATABASE);
}

/** Volta a rede: o navegador dispara `online`, o gatilho que não depende de Background Sync. */
async function networkBack(context: BrowserContext) {
  await context.setOffline(true);
  await context.setOffline(false);
}

let server: OrdersServer;

test.beforeEach(async ({ context }) => {
  await mockIdentityApi(context);
  server = await mockOrdersApi(context);
});

test.describe('fila de escrita offline', () => {
  test('três itens gravados sem rede sobrevivem ao recarregamento e chegam uma vez cada ao voltar a rede', async ({
    page,
    context,
  }) => {
    await signIn(page);
    server.mode = 'down';

    // 1. Sem rede: três escritas entram direto na fila do aparelho.
    await context.setOffline(true);
    const ids = await insertQueued(page, 3);

    // 2. A rede volta, mas a API segue fora do ar: o motor tenta e nada se perde. Recarrega o app.
    await context.setOffline(false);
    await expect.poll(() => server.hits.length).toBeGreaterThan(0);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Bom dia|Boa tarde|Boa noite/);

    // 3. Os três continuam lá, na ordem, mesmo depois de recarregar e de tentativas que falharam.
    expect(await queuedIds(page)).toEqual(ids);
    expect(server.executions.size).toBe(0);

    // 4. A API volta e a rede dá o sinal de `online`: cada um chega uma vez, com a própria chave.
    server.mode = 'up';
    await networkBack(context);
    await expect.poll(() => server.executions.size).toBe(3);
    await expect.poll(() => queuedIds(page)).toEqual([]);

    expect([...server.executions.keys()].sort()).toEqual([...ids].sort());
    expect([...server.executions.values()]).toEqual([1, 1, 1]);
    // Os envios aceitos saíram na ordem em que foram gravados.
    expect(server.hits.filter((h) => h.outcome === 'executed').map((h) => h.key)).toEqual(ids);
  });

  test('o servidor gravou mas a resposta se perdeu: o reenvio recebe o resultado guardado e nada duplica', async ({
    page,
    context,
  }) => {
    await signIn(page);
    server.mode = 'lose-response';
    const ids = await insertQueued(page, 2);

    await networkBack(context);
    // 1ª tentativa de cada item: o servidor gravou, a resposta sumiu, o item continua na fila.
    await expect.poll(() => server.executions.size).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await queuedIds(page)).length).toBeGreaterThan(0);

    // O reenvio com a mesma chave devolve o que foi guardado, sem executar outra vez.
    server.mode = 'up';
    await networkBack(context);
    await expect.poll(() => queuedIds(page)).toEqual([]);
    await networkBack(context);

    expect([...server.executions.keys()].sort()).toEqual([...ids].sort());
    expect([...server.executions.values()].every((n) => n === 1)).toBe(true);
    // O primeiro item perdeu a resposta e foi reenviado com a mesma chave (resposta guardada); o segundo, que o
    // motor só alcançou depois, executou uma vez e pronto.
    const outcomesOf = (id: string) =>
      server.hits.filter((h) => h.key === id).map((h) => h.outcome);
    expect(outcomesOf(ids[0])).toEqual(['executed-response-lost', 'replayed']);
    expect(outcomesOf(ids[1])).toEqual(['executed']);
  });

  test('Render acordando (503 com o cabeçalho de roteamento) por vários ciclos não perde nada', async ({
    page,
    context,
  }) => {
    await signIn(page);
    server.mode = 'waking';
    const ids = await insertQueued(page, 3);

    // Vários ciclos de 503: o motor para no primeiro item (FIFO) e tenta de novo sem desistir.
    for (let cycle = 1; cycle <= 4; cycle++) {
      await networkBack(context);
      await expect
        .poll(() => server.hits.filter((h) => h.outcome === 'waking').length)
        .toBeGreaterThanOrEqual(cycle);
      expect(await queuedIds(page)).toEqual(ids);
    }
    expect(new Set(server.hits.map((h) => h.key))).toEqual(new Set([ids[0]]));

    server.mode = 'up';
    await networkBack(context);
    await expect.poll(() => queuedIds(page)).toEqual([]);

    expect([...server.executions.keys()].sort()).toEqual([...ids].sort());
    expect([...server.executions.values()]).toEqual([1, 1, 1]);
  });
});
