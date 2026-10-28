import { join } from 'node:path';
import { expect, screenshot, test } from '../fixtures';
import { expectNoA11yViolations } from '../screens/screen-helpers';
import { SEED_EXERCISE_IDS } from './support/training-seed';
import {
  openTraining,
  startTraining,
  waitForCatalog,
  chooseMuscle,
  chooseEquipment,
} from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

// O envio da fila ao servidor simulado é assíncrono e, com a máquina ocupada, passa dos 5 s de uma verificação comum.
const PUSH = { timeout: 25_000 };

const rows = (page: import('@playwright/test').Page) => page.locator('.list .ui-row .name');

async function expectCenteredComposition(page: import('@playwright/test').Page) {
  const layout = await page.locator('.hero').evaluate((hero) => {
    const group = hero.querySelector('.visuals')!;
    const visuals = group.getBoundingClientRect();
    const images = Array.from(group.children).map((image) => image.getBoundingClientRect());
    const imageCenter =
      (Math.min(...images.map((image) => image.left)) +
        Math.max(...images.map((image) => image.right))) /
      2;
    const chips = hero.querySelector('.chips')!.getBoundingClientRect();
    return {
      visualsBottom: visuals.bottom,
      chipsTop: chips.top,
      centerOffset: Math.abs(chips.left + chips.width / 2 - visuals.left - visuals.width / 2),
      imageOffset: Math.abs(imageCenter - visuals.left - visuals.width / 2),
    };
  });
  expect(layout.chipsTop).toBeGreaterThanOrEqual(layout.visualsBottom);
  expect(layout.centerOffset).toBeLessThan(1);
  expect(layout.imageOffset).toBeLessThan(1);
}

test.describe('exercícios: lista, busca e ficha', () => {
  test('busca "supino" sem acento e sem caixa, e filtra por grupo e equipamento', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);

    const search = page.getByRole('searchbox', { name: 'Buscar exercício' });
    await search.fill('SUPÍNO');
    await expect(rows(page)).toHaveText([
      'Supino inclinado com halteres',
      'Supino reto com barra',
      'Supino reto com halteres',
    ]);
    await expect(page.getByText('3 exercícios achados')).toBeVisible();
    const firstRow = page.locator('.list .ui-row').first();
    await expect(firstRow.locator('.thumb img')).toBeVisible();
    const layout = await firstRow.evaluate((row) => {
      const thumb = row.querySelector('.thumb')!.getBoundingClientRect();
      const text = row.querySelector('.text')!.getBoundingClientRect();
      return { thumbRight: thumb.right, textLeft: text.left };
    });
    expect(layout.thumbRight).toBeLessThanOrEqual(layout.textLeft);
    const support = firstRow.locator('.sub');
    await expect(support).toContainText('sem registro');
    await expect
      .poll(() => support.evaluate((node) => node.scrollWidth <= node.clientWidth))
      .toBe(true);

    await page.getByRole('button', { name: 'Equipamento' }).click();
    await page.getByRole('button', { name: 'Halteres', exact: true }).click();
    await expect(rows(page)).toHaveText([
      'Supino inclinado com halteres',
      'Supino reto com halteres',
    ]);

    await page.getByRole('button', { name: 'Costas', exact: true }).click();
    await expect(page.getByText('Nenhum Exercício Achado')).toBeVisible();
    await page.getByRole('button', { name: 'Limpar Filtros' }).click();
    await expect(page.getByText('16 exercícios')).toBeVisible();
  });

  test('os filtros ficam no endereço e o botão voltar traz a lista como estava', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    await page.getByRole('button', { name: 'Peito', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Buscar exercício' }).fill('halteres');
    await expect(rows(page)).toHaveText([
      'Crucifixo reto com halteres',
      'Supino inclinado com halteres',
      'Supino reto com halteres',
    ]);
    await expect(page).toHaveURL(/group=chest.*q=halteres|q=halteres.*group=chest/);

    await rows(page).first().click();
    await expect(page).toHaveURL(/\/treino\/exercicios\/[0-9a-f-]{36}$/);
    await page.goBack();
    await expect(page).toHaveURL(/q=halteres/);
    await expect(page.getByRole('searchbox', { name: 'Buscar exercício' })).toHaveValue('halteres');
    await expect(page.getByRole('button', { name: 'Peito', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(rows(page)).toHaveCount(3);
  });

  test('o mapa do corpo abre a lista já filtrada pelo músculo (pelo endereço)', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/exercicios?muscle=biceps');
    await expect(rows(page)).toHaveText(['Rosca direta com barra']);
    await expect(
      page.getByRole('button', { name: /Tirar o filtro de músculo: Bíceps/ }),
    ).toBeVisible();
  });

  test('separa o Mapa do Treino do mapa corporal e abre o glossário', async ({ page, context }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    await page.getByRole('link', { name: 'Mapa do Treino' }).click();
    await expect(page.getByRole('heading', { name: 'Mapa do Treino' })).toBeVisible();

    // O glossário abre pelo "?" ao lado das ações de Rotinas e o voltar traz a lista de volta.
    await openTraining(page, '/treino/rotinas');
    await page.getByRole('link', { name: 'Entender Programa Semanal, Rotina e Exercício' }).click();
    await expect(page.getByRole('heading', { name: 'Entenda o Treino' })).toBeVisible();
    await expect(page.getByText('Programa Semanal')).toBeVisible();
    await expect(page.getByText('Rotina', { exact: true })).toBeVisible();
    await expect(page.getByText('Exercício', { exact: true })).toBeVisible();
    await expectNoA11yViolations(page);
    await page.getByRole('button', { name: 'Voltar ao Treino' }).click();
    await expect(page).toHaveURL(/\/treino\/rotinas$/);
  });

  test('mostra de 50 em 50, com "Mostrar mais"', async ({ page, context }) => {
    await startTraining(context, page, { extra: 70 });
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    await expect(rows(page)).toHaveCount(50);
    await page.getByRole('button', { name: /^Mostrar mais \(36\)/ }).click();
    await expect(rows(page)).toHaveCount(86);
    await expect(page.getByRole('button', { name: /^Mostrar mais/ })).toHaveCount(0);
  });

  test('a ficha mostra ilustração, músculos e passo a passo sem créditos inline', async ({
    page,
    context,
  }, info) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    await page.getByRole('searchbox', { name: 'Buscar exercício' }).fill('supino reto com barra');
    await expect(rows(page)).toHaveText(['Supino reto com barra']);
    await rows(page).first().click();
    await expect(page.getByRole('heading', { name: 'Supino reto com barra' })).toBeVisible();
    await expect(page.locator('app-exercise-illustration img').first()).toBeVisible();
    await expect(page.getByText('Tríceps · secundário')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Músculos trabalhados' })).toHaveCount(0);
    await expect(page.locator('.muscle-legend')).toHaveCount(0);
    await expect
      .poll(() =>
        page
          .locator('.hero .visuals')
          .evaluate((node) => node.nextElementSibling?.classList.contains('chips')),
      )
      .toBe(true);
    await expect(page.locator('.muscle-figure')).toHaveCount(2);
    await expectCenteredComposition(page);
    await expect(page.locator('.chips .ui-chip').first()).toHaveCSS('text-align', 'center');
    await expectNoA11yViolations(page);
    await expect(page.getByText('Ilustração: Everkinetic')).toHaveCount(0);
    if (process.env['TRAINING_SHOTS_DIR']) {
      await screenshot(
        page,
        join(process.env['TRAINING_SHOTS_DIR'], `ficha-exercicio-${info.project.name}.png`),
      );
    }
    await expect(page.locator('.steps li')).toHaveCount(3);
    await page.getByRole('button', { name: 'Ver todos os 5 passos' }).click();
    await expect(page.locator('.steps li')).toHaveCount(5);
    await expect(page.locator('.origin')).toHaveCount(0);
  });

  test('a ficha sem ilustração mantém apenas as faces com músculos destacados', async ({
    page,
    context,
  }, info) => {
    await startTraining(context, page);
    await openTraining(page, `/treino/exercicios/${SEED_EXERCISE_IDS.plank}`);
    await expect(page.getByRole('heading', { name: 'Prancha isométrica' })).toBeVisible();
    await expect(page.locator('app-exercise-illustration')).toHaveCount(0);
    await expect(page.locator('.muscle-figure')).toHaveCount(1);
    await expect(page.locator('.muscle-figure figcaption')).toHaveText('Frente');
    await expect(page.locator('.muscle-figure svg')).toHaveAccessibleName(
      'Frente; principais: Abdômen',
    );
    await expectCenteredComposition(page);
    await expect(page.getByRole('heading', { name: 'Músculos trabalhados' })).toHaveCount(0);
    await expectNoA11yViolations(page);
    if (process.env['TRAINING_SHOTS_DIR']) {
      await screenshot(
        page,
        join(process.env['TRAINING_SHOTS_DIR'], `ficha-frente-${info.project.name}.png`),
      );
    }

    await openTraining(page, `/treino/exercicios/${SEED_EXERCISE_IDS.pushdown}`);
    await expect(page.locator('.muscle-figure')).toHaveCount(1);
    await expect(page.locator('.muscle-figure figcaption')).toHaveText('Costas');
    await expectNoA11yViolations(page);
    if (process.env['TRAINING_SHOTS_DIR']) {
      await screenshot(
        page,
        join(process.env['TRAINING_SHOTS_DIR'], `ficha-costas-${info.project.name}.png`),
      );
    }
  });

  test('a ficha do wger mostra o crédito individual', async ({ page, context }) => {
    await startTraining(context, page);
    await openTraining(page, `/treino/exercicios/${SEED_EXERCISE_IDS.wger}`);
    const credit = page.locator('.source-credit');
    await expect(credit).toContainText('Exercício: Maria Souza, CC-BY-SA 4');
    await expect(credit.getByRole('link', { name: 'CC-BY-SA 4' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by-sa/4.0/',
    );
  });

  test('adiciona o exercício a uma rotina com 3 séries de 8 a 12 repetições', async ({
    page,
    context,
  }) => {
    const server = await startTraining(context, page);
    await openTraining(page, `/treino/exercicios/${SEED_EXERCISE_IDS.pushUp}`);
    await page.getByRole('button', { name: 'Adicionar a um Treino' }).click();
    const sheet = page.getByRole('dialog', { name: 'Adicionar a um Treino' });
    await sheet.getByRole('button', { name: /Treino A/ }).click();
    await expect(page.getByText('Adicionado a Treino A · Peito e tríceps.')).toBeVisible();
    await expect.poll(() => server.writes('routines'), PUSH).toBe(1);
    const routine = server
      .rows('routines')
      .find((row) => String(row['name']).startsWith('Treino A'))!;
    const items = routine['items'] as {
      exerciseId: string;
      targetSets: number;
      repMin: number;
      repMax: number;
    }[];
    expect(items).toHaveLength(4);
    expect(items[3]).toMatchObject({
      exerciseId: SEED_EXERCISE_IDS.pushUp,
      targetSets: 3,
      repMin: 8,
      repMax: 12,
    });
  });

  test('o salto de carga se edita na ficha e sobe uma vez', async ({ page, context }) => {
    const server = await startTraining(context, page);
    await openTraining(page, `/treino/exercicios/${SEED_EXERCISE_IDS.bench}`);
    await expect(page.getByText('padrão de barra')).toBeVisible();
    await page.getByRole('button', { name: 'Editar', exact: true }).click();
    await page.getByLabel('Salto, em kg').fill('1,25');
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(page.getByText('ajustado por você')).toBeVisible();
    await expect(page.getByText('1,25 kg')).toBeVisible();
    await expect
      .poll(
        () =>
          server.hits.filter((hit) => hit.path.endsWith('/step') && hit.outcome === 'executed')
            .length,
        PUSH,
      )
      .toBe(1);
    const row = server.rows('exercises').find((item) => item.id === SEED_EXERCISE_IDS.bench)!;
    expect(row['stepKg']).toBe(1.25);
  });
});

test.describe('exercício próprio', () => {
  test('cria, vê na lista com a marca "própria", edita e apaga', async ({ page, context }) => {
    const server = await startTraining(context, page);
    await openTraining(page, '/treino/exercicios/novo');
    await page.getByLabel('Nome').fill('Remada na máquina articulada');
    await chooseMuscle(page, 'Meio das costas');
    await chooseEquipment(page, 'Máquina');
    await page.getByRole('button', { name: 'Instruções (opcional)' }).click();
    await page.getByLabel('Instruções do exercício').fill('Ajuste o banco.\nPuxe as alças.');
    await page.getByRole('button', { name: 'Salvar Exercício' }).click();
    await expect(page.getByRole('heading', { name: 'Remada na máquina articulada' })).toBeVisible();
    await expect(page.getByText('Exercício criado por você neste aparelho.')).toBeVisible();
    await expect(page.locator('.steps li')).toHaveText(['Ajuste o banco.', 'Puxe as alças.']);

    await page.goto('/treino/exercicios');
    await page.getByRole('searchbox', { name: 'Buscar exercício' }).fill('articulada');
    await expect(rows(page)).toHaveText(['Remada na máquina articulada']);
    await expect(page.locator('.list .ui-chip', { hasText: 'própria' })).toBeVisible();
    await expect.poll(() => server.writes('exercises'), PUSH).toBe(1);

    await rows(page).first().click();
    await page.getByRole('link', { name: 'Editar', exact: true }).click();
    await page.getByLabel('Nome').fill('Remada articulada');
    await page.getByRole('button', { name: 'Salvar Exercício' }).click();
    await expect(page.getByRole('heading', { name: 'Remada articulada' })).toBeVisible();
    await expect
      .poll(
        () => server.rows('exercises').filter((row) => row['source'] === 'own')[0]?.['name'],
        PUSH,
      )
      .toBe('Remada articulada');

    await page.getByRole('button', { name: 'Apagar', exact: true }).click();
    await page.locator('.confirm').getByRole('button', { name: 'Apagar', exact: true }).click();
    await expect(page).toHaveURL(/\/treino\/exercicios/);
    await expect(page.getByRole('heading', { name: 'Remada articulada' })).toHaveCount(0);
    await expect
      .poll(
        () => server.rows('exercises').filter((row) => row['source'] === 'own')[0]?.['deleted'],
        PUSH,
      )
      .toBe(true);
  });

  test('sair do formulário com alterações pede confirmação, e sem alterações sai direto', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    await page.getByRole('link', { name: 'Novo Exercício' }).click();
    await expect(page.getByRole('heading', { name: 'Novo Exercício' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page).toHaveURL(/\/treino\/exercicios$/);

    await page.getByRole('link', { name: 'Novo Exercício' }).click();
    await page.getByLabel('Nome').fill('Algo');
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByText('Sair sem salvar?')).toBeVisible();
    await expect(page).toHaveURL(/\/treino\/exercicios\/novo$/);
    await page.getByRole('button', { name: 'Sair sem Salvar' }).click();
    await expect(page).toHaveURL(/\/treino\/exercicios$/);
  });

  test('um nome repetido só avisa, não impede', async ({ page, context }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/exercicios/novo');
    await page.getByLabel('Nome').fill('Supino reto com barra');
    await expect(page.getByText('Já existe um exercício com este nome')).toBeVisible();
    await chooseMuscle(page, 'Peitoral');
    await page.getByRole('button', { name: 'Salvar Exercício' }).click();
    await expect(page).toHaveURL(/\/treino\/exercicios\/[0-9a-f-]{36}$/);
  });
});
