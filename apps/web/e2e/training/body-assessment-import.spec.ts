import { Page } from '@playwright/test';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { openTraining, startTraining } from './support/training-pages';

test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

interface MeasureRow {
  readonly type: string;
  readonly value: string;
  readonly unit: string;
  readonly side?: 'right' | 'left';
}

/** Preenche uma medida do editor pelos identificadores de cada linha (a primeira linha já existe ao abrir). */
async function addMeasure(page: Page, index: number, row: MeasureRow): Promise<void> {
  await page.getByRole('button', { name: 'Adicionar Medida' }).click();
  await page.locator(`#type-${index}`).fill(row.type);
  await page.locator(`#value-${index}`).fill(row.value);
  await page.getByRole('textbox', { name: 'Unidade' }).nth(index).fill(row.unit);
  await page.locator(`#method-${index}`).fill('fita');
  if (row.side) await page.locator(`#side-${index}`).selectOption(row.side);
}

test('leva à tela Corpo as medidas novas com lado, sem inventar e sem promover o que não vale', async ({
  page,
  context,
}) => {
  await startTraining(context, page);
  await openTraining(page, '/treino/corpo/avaliacoes/nova');
  await page.getByLabel('Data da avaliação').fill('2026-04-05');
  await page.getByLabel('Origem / clínica / sistema').fill('Clínica sintética');

  const rows: readonly MeasureRow[] = [
    { type: 'chest', value: '98', unit: 'cm' },
    { type: 'arm-contracted', value: '35', unit: 'cm', side: 'right' },
    { type: 'arm-contracted', value: '33,5', unit: 'cm', side: 'left' },
    { type: 'forearm', value: '28', unit: 'cm', side: 'right' },
    // "00" é preenchimento do relatório, e a dobra sem unidade em milímetros não é inequívoca: nenhuma das duas vira medida.
    { type: 'calf', value: '00', unit: 'cm', side: 'left' },
    { type: 'skinfold-chest', value: '8', unit: 'cm' },
    { type: 'skinfold-abdominal', value: '15', unit: 'mm' },
  ];
  for (const [index, row] of rows.entries()) await addMeasure(page, index, row);
  await page.getByRole('button', { name: 'Salvar Avaliação' }).click();
  await expect(page).toHaveURL(/\/treino\/corpo\/avaliacoes\/[0-9a-f-]{36}$/);

  await page.getByRole('button', { name: /Levar medidas ao Corpo/ }).click();
  const choices = page.locator('.transfer-option input[type="checkbox"]');
  // Tórax, braço D, braço E, antebraço D e a dobra abdominal em mm; a panturrilha "00" e a dobra em cm ficam de fora.
  await expect(choices).toHaveCount(5);
  for (const choice of await choices.all()) {
    await expect(choice).not.toBeChecked();
    await choice.check();
  }
  await page.getByRole('button', { name: 'Registrar Campos Selecionados' }).click();
  await expect(
    page.getByText('Os campos selecionados foram registrados no Corpo', { exact: false }),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);

  await openTraining(page, '/treino/corpo');
  await page.getByRole('button', { name: 'Entendi' }).click();
  const map = page.locator('app-body-map-panel');
  await expect(map.locator('.side-card', { hasText: /^\s*Braços/ })).toHaveAccessibleName(
    /direito 35,0\s+cm, esquerdo 33,5\s+cm, direito maior em 1,5\s+cm/,
  );
  // Antebraço só do lado direito: o cartão pede o outro lado em vez de inventar uma diferença.
  await expect(map.locator('.side-card', { hasText: /^\s*Antebraços/ })).toHaveAccessibleName(
    /Registre os dois lados/,
  );
  // A panturrilha rejeitada não criou medida nenhuma.
  await expect(map.locator('.side-card', { hasText: /^\s*Panturrilhas/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Registros' }).click();
  await page.locator('app-body-section').nth(2).getByRole('button').first().click();
  const list = page.locator('.measure-list');
  await expect(list.getByText('Tórax', { exact: true })).toBeVisible();
  await expect(list.getByText('Braço D', { exact: true })).toBeVisible();
  await expect(list.getByText('Dobra Abdominal', { exact: true })).toBeVisible();
  await expect(list.getByText('Panturrilha E', { exact: true })).toHaveCount(0);
  await expect(list.getByText('Dobra Peitoral', { exact: true })).toHaveCount(0);
});
