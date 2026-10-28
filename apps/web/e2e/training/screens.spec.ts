import { BrowserContext, Page, TestInfo } from '@playwright/test';
import { join } from 'node:path';
import { settle } from '../screens/screen-helpers';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { SEED_EXERCISE_IDS, SEED_ROUTINE_IDS } from './support/training-seed';
import {
  openTraining,
  startTraining,
  waitForCatalog,
  chooseMuscle,
  chooseEquipment,
} from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/**
 * Capturas de cada tela e estado do Treino, nos dois viewports e nos dois temas. Vão para `test-results/training`; para
 * revisar a mão, aponte `TRAINING_SHOTS_DIR` para outra pasta.
 */
const DIR = process.env['TRAINING_SHOTS_DIR'] ?? 'test-results/training';

// A coleção inteira (umas 20 telas e estados, nos dois temas) só roda para revisar a mão, com a pasta de destino indicada;
// na esteira entram só duas capturas, para a tela abrir e o print sair sem custar login e captura demais no WebKit do Linux.
const ESSENTIAL = new Set([
  'Exercícios: a lista',
  'Editor: a rotina',
  'Treino: cabeçalho e navegação',
]);

interface Fixtures {
  page: Page;
  context: BrowserContext;
}

function shotTest(title: string, body: (fixtures: Fixtures, info: TestInfo) => Promise<void>) {
  if (process.env['TRAINING_SHOTS_DIR'] || ESSENTIAL.has(title)) test(title, body);
}

async function shot(page: Page, info: TestInfo, name: string, scheme: string): Promise<void> {
  await settle(page);
  await screenshot(page, join(DIR, `${name}-${scheme}-${info.project.name}.png`));
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`telas do Treino, tema ${scheme === 'light' ? 'claro' : 'escuro'}`, () => {
    test.beforeEach(async ({ page }) => {
      // Sem movimento: a captura e o axe veem a tela parada, e a ilustração não troca de pose no meio.
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    });

    shotTest('Exercícios: a lista', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, '/treino/exercicios');
      await waitForCatalog(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      await shot(page, info, 'biblioteca', scheme);
    });

    shotTest('Exercícios: filtros de grupo e de equipamento', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, '/treino/exercicios');
      await waitForCatalog(page);
      await page.getByRole('button', { name: 'Peito', exact: true }).click();
      await page.getByRole('button', { name: 'Equipamento' }).click();
      await page.getByRole('button', { name: 'Barra', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'achado' })).toBeVisible();
      await shot(page, info, 'biblioteca-filtros', scheme);
    });

    shotTest('Exercícios: busca com resultado e sem resultado', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, '/treino/exercicios');
      await waitForCatalog(page);
      await page.getByRole('searchbox', { name: 'Buscar exercício' }).fill('supino');
      await expect(page.getByText('3 exercícios achados')).toBeVisible();
      await shot(page, info, 'biblioteca-busca', scheme);
      await page.getByRole('searchbox', { name: 'Buscar exercício' }).fill('zzzz');
      await expect(page.getByText('Nenhum Exercício Achado')).toBeVisible();
      await shot(page, info, 'biblioteca-sem-resultado', scheme);
    });

    shotTest('Exercícios: mais de uma página', async ({ page, context }, info) => {
      await startTraining(context, page, { extra: 70 });
      await openTraining(page, '/treino/exercicios');
      await waitForCatalog(page);
      await page.getByRole('button', { name: /^Mostrar Mais/ }).scrollIntoViewIfNeeded();
      await shot(page, info, 'biblioteca-mostrar-mais', scheme);
    });

    shotTest(
      'Exercícios: catálogo que ainda não chegou, sem rede',
      async ({ page, context }, info) => {
        const server = await startTraining(context, page, { catalog: false });
        server.offline = true;
        await openTraining(page, '/treino/exercicios');
        await expect(page.getByText('O Catálogo Ainda Não Chegou')).toBeVisible();
        await shot(page, info, 'biblioteca-vazia', scheme);
      },
    );

    shotTest('Ficha: com ilustração', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, `/treino/exercicios/${SEED_EXERCISE_IDS.bench}`);
      await expect(page.getByRole('heading', { name: 'Supino reto com barra' })).toBeVisible();
      await expect(page.locator('app-exercise-illustration img').first()).toBeVisible();
      await shot(page, info, 'ficha-com-arte', scheme);
      await page.getByRole('button', { name: 'Ver Todos os 5 Passos' }).scrollIntoViewIfNeeded();
      await shot(page, info, 'ficha-com-arte-meio', scheme);
    });

    shotTest('Ficha: sem ilustração', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, `/treino/exercicios/${SEED_EXERCISE_IDS.plank}`);
      await expect(page.getByRole('heading', { name: 'Prancha isométrica' })).toBeVisible();
      await shot(page, info, 'ficha-sem-arte', scheme);
    });

    shotTest('Ficha: exercício do wger, com autor e licença', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, `/treino/exercicios/${SEED_EXERCISE_IDS.wger}`);
      await expect(page.getByRole('link', { name: 'CC-BY-SA 4' })).toBeVisible();
      await page.getByRole('link', { name: 'CC-BY-SA 4' }).scrollIntoViewIfNeeded();
      await shot(page, info, 'ficha-wger', scheme);
    });

    shotTest('Ficha: adicionar a um treino', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, `/treino/exercicios/${SEED_EXERCISE_IDS.pushUp}`);
      await page.getByRole('button', { name: 'Adicionar a um Treino' }).click();
      await expect(page.getByRole('dialog', { name: 'Adicionar a um Treino' })).toBeVisible();
      await shot(page, info, 'ficha-adicionar', scheme);
    });

    shotTest('Novo exercício: formulário vazio e com erros', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, '/treino/exercicios/novo');
      await expect(page.getByRole('heading', { name: 'Novo Exercício' })).toBeVisible();
      await shot(page, info, 'novo-exercicio', scheme);
      await page.getByRole('button', { name: 'Salvar Exercício' }).click();
      await expect(page.getByText('Dê um nome ao exercício.')).toBeVisible();
      await shot(page, info, 'novo-exercicio-erros', scheme);
    });

    shotTest(
      'Novo exercício: preenchido, com aviso de nome repetido',
      async ({ page, context }, info) => {
        await startTraining(context, page);
        await openTraining(page, '/treino/exercicios/novo');
        await page.getByLabel('Nome').fill('supino RETO com barra');
        await chooseMuscle(page, 'Peitoral');
        await page.getByRole('button', { name: 'Instruções (opcional)' }).click();
        await page.getByLabel('Instruções do exercício').fill('Primeiro passo\nSegundo passo');
        await expect(page.getByText('Já existe um exercício com este nome')).toBeVisible();
        await shot(page, info, 'novo-exercicio-preenchido', scheme);
      },
    );

    shotTest('Ficha de um exercício próprio', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, '/treino/exercicios/novo');
      await page.getByLabel('Nome').fill('Remada na máquina articulada');
      await chooseMuscle(page, 'Meio das costas');
      await chooseEquipment(page, 'Máquina');
      await page.getByRole('button', { name: 'Salvar Exercício' }).click();
      await expect(
        page.getByRole('heading', { name: 'Remada na máquina articulada' }),
      ).toBeVisible();
      await shot(page, info, 'ficha-propria', scheme);
    });

    shotTest('Rotinas: a lista', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, '/treino/rotinas');
      await expect(page.getByText('Treino A · Peito e tríceps')).toBeVisible();
      await shot(page, info, 'rotinas', scheme);
    });

    shotTest('Rotinas: sem nenhuma', async ({ page, context }, info) => {
      await startTraining(context, page, { routines: false });
      await openTraining(page, '/treino/rotinas');
      await expect(page.getByText('Sem Rotinas Ainda')).toBeVisible();
      await shot(page, info, 'rotinas-vazio', scheme);
    });

    shotTest('Rotinas: folha de modelos', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, '/treino/rotinas');
      await page.getByRole('button', { name: 'Comparar Modelos' }).click();
      await expect(page.getByRole('button', { name: /Full body/ })).toBeVisible();
      await shot(page, info, 'rotinas-modelos', scheme);
    });

    shotTest('Rotinas: sem rede, modelos desligados', async ({ page, context }, info) => {
      const server = await startTraining(context, page);
      await openTraining(page, '/treino/rotinas');
      await expect(page.getByText('Treino A · Peito e tríceps')).toBeVisible();
      server.offline = true;
      await context.setOffline(true);
      await expect(page.getByText('Os modelos prontos precisam de rede')).toBeVisible();
      await shot(page, info, 'rotinas-sem-rede', scheme);
      await context.setOffline(false);
    });

    shotTest('Editor: a rotina', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, `/treino/rotinas/${SEED_ROUTINE_IDS.a}`);
      await expect(page.getByRole('heading', { name: 'Editar Rotina' })).toBeVisible();
      await expect(page.getByText('Supino reto com barra')).toBeVisible();
      await shot(page, info, 'editor', scheme);
    });

    shotTest('Editor: um exercício aberto', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, `/treino/rotinas/${SEED_ROUTINE_IDS.a}`);
      await page
        .getByRole('button', { name: /Supino reto com barra/ })
        .first()
        .click();
      await expect(page.getByRole('group', { name: 'Séries' })).toBeVisible();
      await shot(page, info, 'editor-aberto', scheme);
    });

    shotTest('Editor: folha de adicionar exercício', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, `/treino/rotinas/${SEED_ROUTINE_IDS.a}`);
      await page.getByRole('button', { name: 'Adicionar Exercício' }).click();
      await expect(page.getByRole('dialog', { name: 'Adicionar Exercício' })).toBeVisible();
      await shot(page, info, 'editor-adicionar', scheme);
    });

    shotTest('Editor: nova rotina com erros', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, '/treino/rotinas/nova');
      await page.getByLabel('Nome da rotina').fill('');
      await page.getByRole('button', { name: 'Salvar Rotina' }).click();
      await expect(page.getByText('Dê um nome à rotina.')).toBeVisible();
      await shot(page, info, 'editor-erros', scheme);
    });

    shotTest('Pendências: a linha e a folha', async ({ page, context }, info) => {
      const server = await startTraining(context, page);
      server.failNext({
        method: 'PUT',
        path: /^exercises\//,
        status: 422,
        problem: 'client-clock-ahead',
        times: 9,
      });
      await openTraining(page, '/treino/exercicios/novo');
      await page.getByLabel('Nome').fill('Remada na máquina articulada');
      await chooseMuscle(page, 'Meio das costas');
      await page.getByRole('button', { name: 'Salvar Exercício' }).click();
      await expect(page.getByText('1 com erro')).toBeVisible();
      await shot(page, info, 'pendencias-linha', scheme);
      await page.locator('.training-header .status').click();
      await expect(page.getByRole('dialog', { name: 'Alterações com Erro' })).toBeVisible();
      await shot(page, info, 'pendencias-folha', scheme);
    });

    shotTest('Hoje: a tela provisória', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, '/treino');
      await expect(page.getByRole('heading', { name: 'Início' })).toBeVisible();
      await shot(page, info, 'hoje', scheme);
    });

    shotTest('Treino: cabeçalho e navegação', async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, '/treino');
      const header = page.locator('.training-header');
      await expect(header.getByRole('heading', { name: 'Treino' })).toBeVisible();
      await expect(header.locator('.back svg path')).toHaveCount(1);
      await expect(header.getByRole('link', { name: 'Ajustes' })).toBeVisible();
      await expect(header.locator('.status')).toBeVisible();
      const titleBox = await header.getByRole('heading').boundingBox();
      const statusBox = await header.locator('.status').boundingBox();
      expect(statusBox!.x).toBeGreaterThan(titleBox!.x + titleBox!.width);
      // Colado no topo e de borda a borda (a tela de baixo é que guarda o respiro lateral).
      const headerBox = await header.boundingBox();
      const viewport = page.viewportSize()!;
      expect(headerBox!.x).toBe(0);
      expect(headerBox!.y).toBe(0);
      expect(headerBox!.width).toBe(viewport.width);
      // O toque sempre responde, mesmo com o puxar de fundo já em andamento, e nenhum texto aparece.
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const status = header.locator('.status');
      await expect(status).toBeEnabled();
      await status.click();
      await expect(status).toHaveAttribute('data-state', 'busy');
      await expect(page.locator('app-training-sync-line')).toBeHidden();
      await expect(status).toHaveText('');
      await expect(status).toHaveAttribute('data-state', 'ok');
      const tabs = page.getByRole('navigation', { name: 'Abas do módulo' });
      await expect(tabs).toBeVisible();
      const tapHighlights = await Promise.all(
        [header.locator('.status'), tabs].map((element) =>
          element.evaluate((node) =>
            getComputedStyle(node).getPropertyValue('-webkit-tap-highlight-color').trim(),
          ),
        ),
      );
      if (info.project.name === 's23-fe') {
        expect(tapHighlights).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
      }
      // A pílula da aba ativa fica só atrás do ícone (cada aba tem a sua), nunca atravessando a barra.
      const tabWidths = await tabs.locator('ul').evaluate((list) => ({
        bar: list.getBoundingClientRect().width,
        activePill:
          list.querySelector('a.active .pill')?.getBoundingClientRect().width ?? Number.NaN,
      }));
      expect(tabWidths.activePill).toBeGreaterThan(0);
      expect(tabWidths.activePill).toBeLessThan(tabWidths.bar / 3);
      await expectNoHorizontalScroll(page);
      await shot(page, info, 'cabecalho-navegacao', scheme);
    });
  });
}
