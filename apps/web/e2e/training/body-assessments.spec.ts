import AxeBuilder from '@axe-core/playwright';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { openTraining, startTraining } from './support/training-pages';

test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

test('guarda uma avaliação e as fotos do relatório só neste aparelho, sem rede', async ({
  page,
  context,
}) => {
  const server = await startTraining(context, page);
  server.offline = true;
  await openTraining(page, '/treino/corpo/avaliacoes/assessment-cache');
  await expect(page.getByRole('heading', { name: 'Avaliação não encontrada' })).toBeVisible();
  await openTraining(page, '/treino/corpo/avaliacoes/nova');
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.getByLabel('Data da avaliação').fill('2026-04-05');
  await page.getByLabel('Origem / clínica / sistema').fill('Clínica sintética');
  await page.getByRole('button', { name: 'Adicionar medida' }).click();
  await page.getByRole('combobox', { name: 'Medida' }).fill('calf');
  await page.getByLabel('Valor').fill('00');
  await page.getByLabel('Unidade').fill('cm');
  await page.getByLabel('Método').fill('fita');
  await page.getByRole('button', { name: 'Adicionar medida' }).click();
  await page.locator('#type-1').fill('weight');
  await page.locator('#value-1').fill('82.4');
  await page.getByRole('textbox', { name: 'Unidade' }).nth(1).fill('kg');
  await page.locator('#method-1').fill('balança');

  const jpeg = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('Canvas de teste indisponível.');
      context.fillStyle = '#315b4b';
      context.fillRect(0, 0, 2, 2);
      return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    }),
    'base64',
  );
  await page.locator('#documents').setInputFiles({
    name: 'relatorio-sintetico.jpg',
    mimeType: 'image/jpeg',
    buffer: jpeg,
  });
  await expect(page.locator('app-physical-assessment-editor-page .status')).toContainText(
    'Toque em Salvar avaliação',
  );
  await page.getByRole('button', { name: 'Salvar avaliação' }).click();

  await expect(page).toHaveURL(/\/treino\/corpo\/avaliacoes\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: '05 de abril de 2026' })).toBeVisible();
  await expect(page.getByText('Clínica sintética')).toBeVisible();
  await expect(page.getByText('00 cm')).toBeVisible();
  await expect(page.getByText('Medido').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'relatorio-sintetico.jpg', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Arquivos salvos apenas neste aparelho.')).toBeVisible();
  expect(server.hits.filter((hit) => hit.method === 'PUT')).toEqual([]);

  await page.getByRole('button', { name: 'relatorio-sintetico.jpg', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Imagem do relatório anexado' })).toBeVisible();
  await page.getByRole('button', { name: 'Fechar' }).click();

  await expectNoHorizontalScroll(page);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);

  await page.getByRole('button', { name: /Levar medidas ao Corpo/ }).click();
  const transferChoices = page.locator('.transfer-option input[type="checkbox"]');
  await expect(transferChoices).toHaveCount(1);
  await expect(transferChoices.first()).not.toBeChecked();
  await transferChoices.first().check();
  await expect(page.getByText('Anotação que será registrada no Corpo')).toBeVisible();
  await page.getByRole('button', { name: 'Registrar campos selecionados' }).click();
  await expect(
    page.getByText('Os campos selecionados foram registrados no Corpo', { exact: false }),
  ).toBeVisible();
  await openTraining(page, '/treino/corpo');
  await expect(page.getByRole('button', { name: /Peso 82,4\s+kg/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/assessment-body-transfer.png', fullPage: true });
});
