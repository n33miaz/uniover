import { BrowserContext, Page } from '@playwright/test';
import { OWNER, OWNER_ID, mockIdentityApi } from '../../auth/identity-mock';
import { expect } from '../../fixtures';
import { TrainingServer, mockTrainingApi } from './training-server';
import { seedTraining } from './training-seed';

/** O banco local do Treino de uma conta (um por conta no aparelho); sem conta, o do dono. */
export function trainingDbName(accountId: string = OWNER_ID): string {
  return `uniover-training-${accountId}`;
}

/**
 * Sobe a simulação da identidade e a do Treino (já com os dados-semente) e entra como dono. Cada teste chama isto no
 * começo: a API simulada é por contexto, então nada passa de um teste para o outro.
 */
export async function startTraining(
  context: BrowserContext,
  page: Page,
  options: { extra?: number; routines?: boolean; catalog?: boolean } = {},
): Promise<TrainingServer> {
  await mockIdentityApi(context);
  const server = await mockTrainingApi(context);
  seedTraining(server, options);
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  return server;
}

/** Abre uma tela do Treino pelo endereço (a sessão volta pelo cookie simulado) e espera a casca do módulo. */
export async function openTraining(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('app-training-page')).toBeVisible();
}

/**
 * Espera a lista de exercícios chegar do banco local (o catálogo foi puxado do servidor simulado). Com a máquina
 * ocupada, o puxar e a gravação do catálogo no IndexedDB levam alguns segundos: a espera acompanha o trabalho, que é
 * limitado, e não o prazo padrão de 5 s de uma verificação.
 */
export async function waitForCatalog(page: Page): Promise<void> {
  await expect(page.locator('.list .ui-row').first()).toBeVisible({ timeout: 25_000 });
}

/** Quantas linhas tem uma tabela do banco local do Treino de uma conta (sem conta, o do dono). */
export async function countRows(
  page: Page,
  table: string,
  accountId: string = OWNER_ID,
): Promise<number> {
  return page.evaluate(
    ({ name, db: dbName }) =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open(dbName);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction(name).objectStore(name).count();
          request.onsuccess = () => {
            db.close();
            resolve(request.result);
          };
          request.onerror = () => reject(request.error);
        };
      }),
    { name: table, db: trainingDbName(accountId) },
  );
}

/** Escolhe o músculo principal no formulário de exercício: abre a lista por grupo e toca no músculo. */
export async function chooseMuscle(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: /^Músculo principal/ }).click();
  await page
    .getByRole('dialog', { name: 'Músculo Principal' })
    .getByRole('button', { name: label, exact: true })
    .click();
}

/** Escolhe o equipamento no formulário de exercício (os chips de escolha única). */
export async function chooseEquipment(page: Page, label: string): Promise<void> {
  await page
    .getByRole('group', { name: 'Equipamento' })
    .getByRole('button', { name: label, exact: true })
    .click();
}

/**
 * Quantas alterações do aparelho ainda não chegaram ao servidor: lê a fila de escrita (`outbox`) de cada banco local.
 * O anel do cabeçalho some depois de alguns segundos em dia e não é botão de sincronizar; o que prova que tudo chegou ao
 * servidor é a fila vazia.
 */
export function pendingWrites(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const names = ((await indexedDB.databases?.()) ?? []).map((db) => db.name!).filter(Boolean);
    let pending = 0;
    for (const name of names) {
      pending += await new Promise<number>((resolve) => {
        const open = indexedDB.open(name);
        open.onerror = () => resolve(0);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('outbox')) {
            db.close();
            resolve(0);
            return;
          }
          const count = db.transaction('outbox', 'readonly').objectStore('outbox').count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
          count.onerror = () => {
            db.close();
            resolve(0);
          };
        };
      });
    }
    return pending;
  });
}

/** O aparelho está em dia: nada na fila de escrita. */
export async function expectSynced(page: Page, options?: { timeout: number }): Promise<void> {
  await expect.poll(() => pendingWrites(page), { timeout: options?.timeout ?? 15_000 }).toBe(0);
}

/** Sem rede (estado normal): o anel do cabeçalho fica cinza, e o app segue usável. */
export async function expectOfflineIcon(page: Page): Promise<void> {
  await expect(page.locator('app-page-top-bar .ring')).toHaveAttribute('data-state', 'offline');
}
