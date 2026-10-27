import AxeBuilder from '@axe-core/playwright';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { openTraining, startTraining } from '../training/support/training-pages';

test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

test('prioriza sinais e mantém calorias e fotos acessíveis', async ({ page, context }) => {
  const server = await startTraining(context, page);
  await openTraining(page, '/treino/corpo');
  await page.getByRole('button', { name: 'Entendi' }).click();

  const signals = page.locator('.weight-card, .signal-card, .signal-row');
  await expect(signals).toHaveText([
    /Peso/,
    /Medidas/,
    /Gordura Corporal/,
    /Avaliações Físicas/,
    /Mapa do Corpo/,
    /Fotos de Progresso/,
  ]);
  await expect(page.getByRole('button', { name: 'Registrar Peso' })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Avaliações Físicas Ver Histórico' }),
  ).toHaveAttribute('href', '/treino/corpo/avaliacoes');
  await expect(page.getByRole('link', { name: 'Mapa do Corpo Ver Músculos' })).toHaveAttribute(
    'href',
    '/treino/exercicios/mapa',
  );

  await page.getByRole('button', { name: 'Registros' }).click();
  const profileSection = page.locator('app-body-section').nth(1);
  await profileSection.getByRole('button', { name: 'Preencher Perfil' }).click();
  const profile = page.getByRole('dialog', { name: 'Seu Perfil' });
  await profile.getByLabel('Altura (cm)').fill('180');
  await profile.getByLabel('Data de nascimento').fill('1995-06-15');
  await profile.getByRole('button', { name: 'Salvar Perfil' }).click();

  await page.getByRole('button', { name: 'Resumo' }).click();
  await page.getByRole('button', { name: 'Registrar Peso' }).click();
  const weight = page.getByRole('dialog', { name: 'Registrar Peso' });
  await weight.getByLabel('Peso (kg)').fill('82,4');
  await weight.getByRole('button', { name: 'Salvar' }).click();

  await page.getByRole('button', { name: 'Registros' }).click();
  const energy = page.locator('app-body-energy-panel');
  await energy.getByText('Como a Meta Foi Calculada').click();
  await expect(energy.getByText('1.799 kcal')).toBeVisible();
  await energy.getByRole('button', { name: 'Escolher Meta' }).click();
  const goal = energy.getByLabel('Sua Meta Diária (kcal)');
  await goal.fill('1700');
  await energy.getByRole('button', { name: 'Salvar Meta' }).click();
  await expect(energy.getByRole('alert')).toContainText('nunca fica abaixo');
  await goal.fill('2400');
  await energy.getByRole('button', { name: 'Salvar Meta' }).click();
  await expect(energy.locator('.target strong')).toHaveText('2.400');
  await expect.poll(() => server.writes('goals'), { timeout: 15_000 }).toBe(1);

  await page.getByRole('button', { name: 'Resumo' }).click();
  await page.getByRole('button', { name: 'Fotos de Progresso Ver Fotos' }).click();
  await expect(page.getByRole('heading', { name: 'Fotos de Progresso' })).toBeVisible();
  // A troca de aba esmaece o conteúdo por 200 ms: o axe só mede o contraste depois que a animação termina.
  await expect(page.locator('.section-content')).not.toHaveClass(/forward|backward/);
  await expectNoHorizontalScroll(page);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
});
