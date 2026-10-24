import { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { SEED_ROUTINE_IDS } from './support/training-seed';
import { openTraining, startTraining } from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const names = (page: Page) => page.locator('.items .item .name');

test.describe('rotinas: lista e modelos', () => {
  test('lista as rotinas na ordem da sequência, marca a próxima e abre o editor', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/rotinas');
    const rows = page.locator('.list .ui-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Treino A · Peito e tríceps');
    await expect(rows.nth(0)).toContainText('próxima');
    await expect(rows.nth(0)).toContainText('3 exercícios · 10 séries');
    await expect(rows.nth(1)).toContainText('Treino B · Costas e bíceps');
    await rows.nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/treino/rotinas/${SEED_ROUTINE_IDS.b}$`));
    await expect(page.getByRole('heading', { name: 'Editar rotina' })).toBeVisible();
  });

  test('"Usar modelo" escolhe o programa: o aparelho cria as fichas, a lista as mostra e o servidor as recebe', async ({
    page,
    context,
  }) => {
    const server = await startTraining(context, page, { routines: false });
    await openTraining(page, '/treino/rotinas');
    await expect(page.getByText('Sem rotinas ainda')).toBeVisible();
    await page.getByRole('button', { name: 'Usar modelo' }).click();
    const sheet = page.getByRole('dialog', { name: 'Usar um modelo' });
    await expect(sheet.getByRole('button', { name: /Full body/ })).toBeVisible();
    await sheet.getByRole('button', { name: /ABC/ }).click();
    await expect(page.locator('.list .ui-row')).toHaveCount(3);
    await expect(
      page.getByText(/Programa ABC escolhido. Hoje abre no treino do dia./),
    ).toBeVisible();
    await expect(
      page.getByText('1 exercício do modelo não está no seu catálogo e ficou de fora.'),
    ).toBeVisible();
    await expect.poll(() => server.rows('routines').length).toBe(3);
    expect(server.rows('routines').every((row) => row['programId'] === 'abc')).toBe(true);
  });

  test('sem rede, "Usar modelo" fica desligado e diz por quê', async ({ page, context }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/rotinas');
    await expect(page.locator('.list .ui-row').first()).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByRole('button', { name: 'Usar modelo' })).toBeDisabled();
    await expect(page.getByText('Os modelos prontos precisam de rede')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Nova rotina' })).toBeVisible();
  });
});

test.describe('rotinas: editor', () => {
  test('monta a ordem com Subir e Descer, salva e a rotina sobe uma vez', async ({
    page,
    context,
  }) => {
    const server = await startTraining(context, page);
    await openTraining(page, `/treino/rotinas/${SEED_ROUTINE_IDS.a}`);
    await expect(names(page)).toHaveText([
      'Supino reto com barra',
      'Supino inclinado com halteres',
      'Tríceps na polia com corda',
    ]);
    await page.getByRole('button', { name: 'Subir Tríceps na polia com corda' }).click();
    await page.getByRole('button', { name: 'Descer Supino reto com barra' }).click();
    await expect(names(page)).toHaveText([
      'Tríceps na polia com corda',
      'Supino reto com barra',
      'Supino inclinado com halteres',
    ]);
    await page.getByRole('button', { name: 'Salvar rotina' }).click();
    await expect(page).toHaveURL(/\/treino\/rotinas$/);
    await expect.poll(() => server.writes('routines')).toBe(1);
    const routine = server.rows('routines').find((row) => row.id === SEED_ROUTINE_IDS.a)!;
    const items = routine['items'] as { exerciseId: string; position: number }[];
    expect(items.map((item) => item.position)).toEqual([0, 1, 2]);
    expect(items[0].exerciseId).toBe('00000000-0000-4000-8000-000000000011');
  });

  test('muda a meta de um exercício e junta dois em supersérie', async ({ page, context }) => {
    const server = await startTraining(context, page);
    await openTraining(page, `/treino/rotinas/${SEED_ROUTINE_IDS.a}`);
    await page
      .getByRole('button', { name: /Supino reto com barra/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Aumentar séries' }).click();
    await page.getByRole('button', { name: 'Aumentar descanso' }).click();
    await page.getByRole('switch', { name: 'Juntar com o próximo (supersérie)' }).first().check();
    await expect(page.getByText('supersérie: sem descanso entre o par')).toBeVisible();
    await page.getByRole('button', { name: 'Salvar rotina' }).click();
    await expect(page).toHaveURL(/\/treino\/rotinas$/);
    await expect.poll(() => server.writes('routines')).toBe(1);
    const routine = server.rows('routines').find((row) => row.id === SEED_ROUTINE_IDS.a)!;
    const items = routine['items'] as {
      targetSets: number;
      restSeconds: number;
      supersetGroup: number | null;
    }[];
    expect(items[0]).toMatchObject({ targetSets: 5, restSeconds: 135 });
    expect(items[0].supersetGroup).not.toBeNull();
    expect(items[0].supersetGroup).toBe(items[1].supersetGroup);
    expect(items[2].supersetGroup).toBeNull();
  });

  test('adiciona um exercício pela folha com a lista do catálogo', async ({ page, context }) => {
    const server = await startTraining(context, page);
    await openTraining(page, `/treino/rotinas/${SEED_ROUTINE_IDS.b}`);
    await page.getByRole('button', { name: 'Adicionar exercício' }).click();
    const sheet = page.getByRole('dialog', { name: 'Adicionar exercício' });
    await sheet.getByRole('searchbox', { name: 'Buscar exercício' }).fill('elevacao');
    await expect(sheet.locator('.ui-row')).toHaveCount(1);
    await sheet.locator('.ui-row').click();
    await expect(names(page)).toHaveCount(4);
    await expect(names(page).nth(3)).toHaveText('Elevação lateral com halteres');
    await expect(page.locator('.items .meta').nth(3)).toHaveText('3 séries · 8–12 reps · 90 s');
    await page.getByRole('button', { name: 'Salvar rotina' }).click();
    await expect(page).toHaveURL(/\/treino\/rotinas$/);
    await expect.poll(() => server.writes('routines')).toBe(1);
  });

  test('cria uma rotina nova com nome sugerido', async ({ page, context }) => {
    const server = await startTraining(context, page);
    await openTraining(page, '/treino/rotinas');
    // A sugestão de nome conta as rotinas que o aparelho já tem: espera elas chegarem à lista.
    await expect(page.locator('.list .ui-row')).toHaveCount(2);
    await page.getByRole('link', { name: 'Nova rotina' }).click();
    await expect(page.getByLabel('Nome da rotina')).toHaveValue('Treino C');
    await page.getByLabel('Nome da rotina').fill('Pernas');
    await page.getByRole('button', { name: 'Adicionar exercício' }).click();
    const sheet = page.getByRole('dialog', { name: 'Adicionar exercício' });
    await sheet.getByRole('searchbox', { name: 'Buscar exercício' }).fill('agachamento');
    await expect(sheet.locator('.ui-row')).toHaveCount(1);
    await sheet.locator('.ui-row').click();
    await page.getByRole('button', { name: 'Salvar rotina' }).click();
    await expect(page).toHaveURL(/\/treino\/rotinas$/);
    await expect(page.locator('.list .ui-row')).toHaveCount(3);
    await expect.poll(() => server.rows('routines').length).toBe(3);
  });

  test('o editor mostra o erro no campo e não salva rotina inválida', async ({ page, context }) => {
    const server = await startTraining(context, page);
    await openTraining(page, `/treino/rotinas/${SEED_ROUTINE_IDS.a}`);
    await page.getByLabel('Nome da rotina').fill('');
    await page
      .getByRole('button', { name: /Supino inclinado com halteres/ })
      .first()
      .click();
    for (let n = 0; n < 6; n++) {
      await page.getByRole('button', { name: 'Aumentar repetições mínimas' }).click();
    }
    await page.getByRole('button', { name: 'Salvar rotina' }).click();
    await expect(page.getByText('Dê um nome à rotina.')).toBeVisible();
    await expect(page.getByText('A repetição mínima não pode passar da máxima.')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/treino/rotinas/${SEED_ROUTINE_IDS.a}$`));
    expect(server.writes('routines')).toBe(0);
  });

  test('cancelar com alteração pede confirmação, e sem alteração sai direto', async ({
    page,
    context,
  }) => {
    const server = await startTraining(context, page);
    await openTraining(page, '/treino/rotinas');
    await page.locator('.list .ui-row').first().click();
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page).toHaveURL(/\/treino\/rotinas$/);

    await page.locator('.list .ui-row').first().click();
    await page.getByRole('button', { name: 'Descer Supino reto com barra' }).click();
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByText('Sair sem salvar?')).toBeVisible();
    await page.getByRole('button', { name: 'Continuar editando' }).click();
    await expect(page.getByLabel('Nome da rotina')).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('button', { name: 'Sair sem salvar' }).click();
    await expect(page).toHaveURL(/\/treino\/rotinas$/);
    expect(server.writes('routines')).toBe(0);
  });

  test('apaga a rotina por lápide, só depois de confirmar', async ({ page, context }) => {
    const server = await startTraining(context, page);
    await openTraining(page, `/treino/rotinas/${SEED_ROUTINE_IDS.b}`);
    await page.getByRole('button', { name: 'Apagar rotina' }).click();
    await expect(page.getByText('Apagar esta rotina?')).toBeVisible();
    await page.getByRole('button', { name: 'Manter' }).click();
    await expect(page.getByRole('button', { name: 'Apagar rotina' })).toBeVisible();
    await page.getByRole('button', { name: 'Apagar rotina' }).click();
    await page.locator('.ui-notice').getByRole('button', { name: 'Apagar', exact: true }).click();
    await expect(page).toHaveURL(/\/treino\/rotinas$/);
    await expect(page.locator('.list .ui-row')).toHaveCount(1);
    await expect
      .poll(() => server.rows('routines').find((row) => row.id === SEED_ROUTINE_IDS.b)?.['deleted'])
      .toBe(true);
  });

  test('arrasta pela alça para mudar a ordem (Chromium)', async ({ page, context }, info) => {
    test.skip(info.project.name !== 's23-fe', 'O arrastar por ponteiro é medido no Chromium.');
    await startTraining(context, page);
    await openTraining(page, `/treino/rotinas/${SEED_ROUTINE_IDS.a}`);
    await expect(names(page)).toHaveCount(3);
    const grip = page.locator('.items .entry').nth(0).locator('.grip');
    const target = page.locator('.items .entry').nth(2);
    const from = (await grip.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(names(page).last()).toHaveText('Supino reto com barra');
    await expect(names(page).first()).toHaveText('Supino inclinado com halteres');
  });
});
