import { expect, test } from '../fixtures';
import { SEED_EXERCISE_IDS } from './support/training-seed';
import { openTraining, startTraining, waitForCatalog } from './support/training-pages';

test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

test('a única volta do Treino fica no topo e restaura a lista filtrada', async ({
  page,
  context,
}) => {
  await startTraining(context, page);
  await openTraining(page, '/treino/exercicios');
  await waitForCatalog(page);
  await page.getByRole('searchbox', { name: 'Buscar exercício' }).fill('halteres');
  await page.locator('.list .ui-row').first().click();

  const back = page.locator('app-page-top-bar .back');
  await expect(back).toHaveCount(1);
  await expect(page.locator('app-training-page .content [aria-label^="Voltar"]')).toHaveCount(0);
  await back.click();
  await expect(page).toHaveURL(/\/treino\/exercicios\?.*q=halteres/);
});

test('a volta de um endereço aberto direto troca a ficha pelo pai lógico', async ({
  page,
  context,
}) => {
  await startTraining(context, page);
  await openTraining(page, `/treino/exercicios/${SEED_EXERCISE_IDS.bench}`);
  await page.locator('app-page-top-bar .back').click();
  await expect(page).toHaveURL(/\/treino\/exercicios$/);
});

const ROUTES = [
  '/treino',
  '/treino/exercicios',
  '/treino/exercicios/novo',
  `/treino/exercicios/${SEED_EXERCISE_IDS.bench}`,
  '/treino/rotinas',
  '/treino/rotinas/nova',
  '/treino/glossario',
  '/treino/progresso',
  '/treino/corpo',
  '/treino/corpo/avaliacoes',
  '/treino/alimentacao',
];

for (const route of ROUTES) {
  test(`${route}: exatamente uma seta de voltar e no máximo um três pontos, ambos no topo`, async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openTraining(page, route);
    await expect(page.locator('app-page-top-bar')).toHaveCount(1);
    await expect(page.locator('app-page-top-bar .back')).toHaveCount(1);
    await expect(
      page.locator(
        'app-training-page .content [aria-label^="Voltar"], app-training-page .content a[href="/"]',
      ),
    ).toHaveCount(0);
    expect(await page.locator('[aria-label="Mais opções"]').count()).toBeLessThanOrEqual(1);
    await expect(page.locator('app-page-top-bar [aria-label="Mais opções"]')).toHaveCount(
      await page.locator('[aria-label="Mais opções"]').count(),
    );
  });
}
