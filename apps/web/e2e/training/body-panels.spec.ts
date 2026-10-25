import { expect, test, expectNoHorizontalScroll } from '../fixtures';
import AxeBuilder from '@axe-core/playwright';
import { openTraining, startTraining } from '../training/support/training-pages';

test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

test('estima a meta e mantém fotos locais ao usar sem rede', async ({ page, context }) => {
  const server = await startTraining(context, page);
  await openTraining(page, '/treino/corpo');
  await page.getByRole('button', { name: 'Entendi' }).click();

  await page
    .locator('app-body-section')
    .nth(1)
    .getByRole('button', { name: 'Preencher perfil' })
    .click();
  const profile = page.getByRole('dialog', { name: 'Seu perfil' });
  await profile.getByLabel('Altura (cm)').fill('180');
  await profile.getByLabel('Data de nascimento').fill('1995-06-15');
  await profile.getByRole('button', { name: 'Salvar perfil' }).click();

  await page.getByRole('button', { name: 'Registrar peso' }).click();
  const weight = page.getByRole('dialog', { name: 'Registrar peso' });
  await weight.getByLabel('Peso (kg)').fill('82,4');
  await weight.getByRole('button', { name: 'Salvar' }).click();
  await page.getByRole('button', { name: 'Calorias' }).click();
  const energy = page.locator('app-body-energy-panel');
  await energy.getByText('Como a meta foi calculada').click();
  await expect(energy.getByText('1.799 kcal')).toBeVisible();
  await energy.getByRole('button', { name: 'Escolher meta' }).click();
  const goal = energy.getByLabel('Sua meta diária (kcal)');
  await goal.fill('1700');
  await energy.getByRole('button', { name: 'Salvar meta' }).click();
  await expect(energy.getByRole('alert')).toContainText('nunca fica abaixo');
  await goal.fill('2400');
  await energy.getByRole('button', { name: 'Salvar meta' }).click();
  await expect(energy.locator('.target strong')).toHaveText('2.400');
  await expect.poll(() => server.writes('goals'), { timeout: 15_000 }).toBe(1);

  await page.getByRole('button', { name: 'Fotos' }).click();
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
  const upload = page.locator('input[type="file"]');
  await upload.setInputFiles({ name: 'progress.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('app-body-photo-panel .photos > p[role="status"]')).toContainText(
    'Foto salva só neste aparelho',
  );
  await upload.setInputFiles({ name: 'progress-again.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.photo-card')).toHaveCount(2);
  await expect(page.locator('.comparison')).toHaveCount(0);
  const compare = page.getByRole('button', { name: 'Comparar' });
  await compare.nth(0).click();
  await compare.nth(1).click();
  await expect(page.locator('.comparison figure')).toHaveCount(2);
  expect(
    await page
      .locator('.photo-card img')
      .evaluateAll((images) =>
        images.every((image) => image.getAttribute('src')?.startsWith('data:image/')),
      ),
  ).toBe(true);
  server.offline = true;
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await upload.setInputFiles({ name: 'progress-offline.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.photo-card')).toHaveCount(3);
  await page
    .locator('.photo-card')
    .first()
    .getByRole('button', { name: /^Apagar foto de/ })
    .click();
  await page.getByRole('button', { name: 'Apagar foto', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(2);

  await expectNoHorizontalScroll(page);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
});
