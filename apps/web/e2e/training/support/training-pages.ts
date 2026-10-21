import { BrowserContext, Page } from '@playwright/test';
import { OWNER, mockIdentityApi } from '../../auth/identity-mock';
import { expect } from '../../fixtures';
import { TrainingServer, mockTrainingApi } from './training-server';
import { seedTraining } from './training-seed';

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

/** Espera a lista de exercícios chegar do banco local (o catálogo foi puxado do servidor simulado). */
export async function waitForCatalog(page: Page): Promise<void> {
  await expect(page.locator('.list .ui-row').first()).toBeVisible();
}

/** O Dexie do Treino: um `put` direto, para o teste montar um estado sem passar pela tela. */
export async function countRows(page: Page, table: string): Promise<number> {
  return page.evaluate(
    (name) =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('uniover-training');
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
    table,
  );
}

/** Escolhe o músculo principal no formulário de exercício: abre a lista por grupo e toca no músculo. */
export async function chooseMuscle(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: /^Músculo principal/ }).click();
  await page
    .getByRole('dialog', { name: 'Músculo principal' })
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
