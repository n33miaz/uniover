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
    /Fotos de Progresso/,
  ]);
  // O mapa mora dentro do Corpo, entre os sinais e os atalhos; não há mais atalho para uma tela só do mapa.
  await expect(
    page.locator('app-body-map-panel').getByRole('heading', { name: 'Mapa do Corpo' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /Mapa do Corpo/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Registrar Peso' })).toBeVisible();
  // O nome acessível dos cartões de sinal é o texto visível (o axe exige que o aria-label o contenha).
  await expect(page.locator('.signal-card').first()).toHaveAccessibleName(
    /Medidas\s+Sem Registros\s+Registrar Medidas/,
  );
  await expect(
    page.getByRole('link', { name: 'Avaliações Físicas Ver Histórico' }),
  ).toHaveAttribute('href', '/treino/corpo/avaliacoes');

  await page.getByRole('button', { name: 'Registros', exact: true }).click();
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

  await page.getByRole('button', { name: 'Registros', exact: true }).click();
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

  await page.getByRole('button', { name: 'Fotos' }).click();
  const photos = page.locator('app-body-photo-panel');
  await expect(photos.getByRole('heading', { name: 'Fotos de Progresso' })).toBeVisible();
  await expect(photos.getByText('Tirar ou Escolher Foto', { exact: true })).toBeVisible();
  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('Canvas indisponível para a imagem de teste.');
      context.fillStyle = '#457b62';
      context.fillRect(0, 0, 2, 2);
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );
  const upload = photos.locator('input[type="file"]');
  await upload.setInputFiles({ name: 'progresso.png', mimeType: 'image/png', buffer: png });
  await expect(photos.locator('p[role="status"]')).toContainText('Foto salva só neste aparelho');
  await upload.setInputFiles({ name: 'progresso-2.png', mimeType: 'image/png', buffer: png });
  await expect(photos.locator('.photo-card')).toHaveCount(2);
  await expect(photos.locator('.comparison')).toHaveCount(0);
  const compare = photos.getByRole('button', { name: 'Comparar' });
  await compare.nth(0).click();
  await compare.nth(1).click();
  await expect(photos.locator('.comparison figure')).toHaveCount(2);
  expect(
    await photos
      .locator('.photo-card img')
      .evaluateAll((images) =>
        images.every((image) => image.getAttribute('src')?.startsWith('data:image/')),
      ),
  ).toBe(true);

  server.offline = true;
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await upload.setInputFiles({ name: 'progresso-offline.png', mimeType: 'image/png', buffer: png });
  await expect(photos.locator('.photo-card')).toHaveCount(3);
  await photos
    .getByRole('button', { name: /^Apagar foto de/ })
    .first()
    .click();
  await photos.getByRole('button', { name: 'Apagar Foto', exact: true }).click();
  await expect(photos.locator('.photo-card')).toHaveCount(2);
  await upload.setInputFiles({
    name: 'progresso-depois-de-apagar.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(photos.locator('.photo-card')).toHaveCount(3);

  // A troca de aba esmaece o conteúdo por 200 ms: o axe só mede o contraste depois que a animação termina.
  await expect(page.locator('.section-content')).not.toHaveClass(/forward|backward/);
  await expectNoHorizontalScroll(page);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
});

test('as fotos de progresso ficam só no aparelho, sem opção de nuvem', async ({
  page,
  context,
}) => {
  const server = await startTraining(context, page);
  await openTraining(page, '/treino/corpo');
  await page.getByRole('button', { name: 'Entendi' }).click();
  await page.getByRole('button', { name: 'Fotos', exact: true }).click();
  const photos = page.locator('app-body-photo-panel');
  await expect(
    photos.getByText('Se o navegador apagar os dados do site', { exact: false }),
  ).toBeVisible();
  await expect(photos.getByText(/nuvem/i)).toHaveCount(0);
  await expect(photos.getByRole('button', { name: /Nuvem/i })).toHaveCount(0);

  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('Canvas indisponível para a imagem de teste.');
      context.fillStyle = '#457b62';
      context.fillRect(0, 0, 2, 2);
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );
  await photos.locator('input[type="file"]').setInputFiles({
    name: 'progresso.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(photos.locator('.photo-card')).toHaveCount(1);
  await expect(photos.getByText('Foto salva só neste aparelho.')).toBeVisible();
  // Nada sobe: o servidor de teste nem tem mais rota de foto, e nenhuma chamada a ela foi feita.
  expect(server.hits.filter((hit) => hit.path.startsWith('progress-photos'))).toEqual([]);
});
