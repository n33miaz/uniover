import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, screenshot, test } from '../fixtures';
import { expectSynced, openTraining, startTraining } from '../training/support/training-pages';

test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

const DIR = process.env['TRAINING_SHOTS_DIR'] ?? 'test-results/training-body';

async function shot(page: Page, info: TestInfo, name: string, scheme: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await screenshot(page, join(DIR, `${name}-${scheme}-${info.project.name}.png`));
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`tela Corpo, tema ${scheme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    });

    test(`captura resumo, registros e fotos no tema ${scheme}`, async ({ page, context }, info) => {
      await startTraining(context, page);
      await openTraining(page, '/treino/corpo');
      await page.getByRole('button', { name: 'Entendi' }).click();
      await expect(page.getByRole('heading', { name: 'Corpo', exact: true })).toBeVisible();
      await expectSynced(page);
      await shot(page, info, 'corpo-resumo', scheme);

      await page.getByRole('button', { name: 'Registros' }).click();
      const profile = page.locator('app-body-section').nth(1);
      await profile.getByRole('button', { name: 'Preencher Perfil' }).click();
      const profileSheet = page.getByRole('dialog', { name: 'Seu Perfil' });
      await profileSheet.getByLabel('Altura (cm)').fill('180');
      await profileSheet.getByLabel('Data de nascimento').fill('1995-06-15');
      await profileSheet.getByRole('button', { name: 'Salvar Perfil' }).click();

      await page.getByRole('button', { name: 'Resumo' }).click();
      await page.getByRole('button', { name: 'Registrar Peso' }).click();
      const weight = page.getByRole('dialog', { name: 'Registrar Peso' });
      await weight.getByLabel('Peso (kg)').fill('82,4');
      await weight.getByRole('button', { name: 'Salvar' }).click();
      await expect(page.locator('.weight-card .weight-value')).toHaveText('82,4 kg');
      await shot(page, info, 'corpo-resumo-com-peso', scheme);

      await page.getByRole('button', { name: 'Registros' }).click();
      await expect(page.locator('app-body-energy-panel')).toBeVisible();
      await shot(page, info, 'corpo-registros', scheme);

      await page.getByRole('button', { name: 'Fotos' }).click();
      await expect(page.getByRole('heading', { name: 'Fotos de Progresso' })).toBeVisible();
      await shot(page, info, 'corpo-fotos-vazio', scheme);
    });
  });
}
