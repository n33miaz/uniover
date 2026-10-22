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
  await expect(page.getByText('Medido')).toBeVisible();
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
});
