import { expect, test } from '../fixtures';
import { openTraining, startTraining } from '../training/support/training-pages';

test.use({ serviceWorkers: 'block' });

test('registra peso e mantém medidas e gordura acessíveis nos registros', async ({
  page,
  context,
}) => {
  await startTraining(context, page);
  await openTraining(page, '/treino/corpo');
  await page.getByRole('button', { name: 'Entendi' }).click();
  await expect(page.getByText('Registre seu primeiro peso.')).toBeVisible();

  await page.getByRole('button', { name: 'Registrar Peso' }).click();
  const dialog = page.getByRole('dialog', { name: 'Registrar Peso' });
  await dialog.getByLabel('Peso (kg)').fill('82,4');
  await dialog.getByLabel('Dia').fill('2026-10-20');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.locator('.weight-card .weight-value')).toHaveText('82,4 kg');

  await page.getByRole('button', { name: 'Registrar Peso' }).click();
  const next = page.getByRole('dialog', { name: 'Registrar Peso' });
  await next.getByLabel('Peso (kg)').fill('81,4');
  await next.getByLabel('Dia').fill('2026-10-21');
  await next.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.locator('.weight-card .weight-meta strong')).toContainText('−0,1');

  await page.getByRole('button', { name: 'Registros', exact: true }).click();
  await page.getByRole('button', { name: 'Editar pesagem de 21/10/2026, 81,4 kg' }).click();
  const edit = page.getByRole('dialog', { name: 'Pesagem de 21/10' });
  await edit.getByLabel('Peso (kg)').fill('81,8');
  await edit.getByRole('button', { name: 'Salvar' }).click();
  await expect(
    page
      .locator('app-body-section')
      .first()
      .getByRole('button', { name: /Peso\s+81,8\s+kg/ }),
  ).toBeVisible();

  const profileSection = page.locator('app-body-section').nth(1);
  if (!(await profileSection.getByRole('button', { name: 'Preencher Perfil' }).isVisible())) {
    await profileSection.getByRole('button').click();
  }
  await profileSection.getByRole('button', { name: 'Preencher Perfil' }).click();
  const profile = page.getByRole('dialog', { name: 'Seu Perfil' });
  await profile.getByLabel('Altura (cm)').fill('180');
  await profile.getByLabel('Data de nascimento').fill('1995-06-15');
  await profile.getByRole('radio', { name: 'Feminino' }).check();
  await profile.getByRole('radio', { name: 'Masculino' }).check();
  await profile.getByRole('radio', { name: '1,9' }).check();
  await profile.getByRole('button', { name: 'Salvar Perfil' }).click();
  await expect(profileSection.getByRole('button', { name: /Perfil 180 cm/ })).toBeVisible();

  const measuresSection = page.locator('app-body-section').nth(2);
  if (!(await measuresSection.getByRole('button', { name: 'Registrar Medidas' }).isVisible())) {
    await measuresSection.getByRole('button').click();
  }
  await measuresSection.getByRole('button', { name: 'Registrar Medidas' }).click();
  const measures = page.getByRole('dialog', { name: 'Registrar Medidas e Gordura' });
  await measures.getByLabel('Cintura', { exact: true }).fill('86');
  await measures.getByLabel('Pescoço', { exact: true }).fill('38');
  await measures.getByRole('radio', { name: 'Bioimpedância' }).check();
  await measures.getByRole('radio', { name: 'Informado por você' }).check();
  await measures.getByRole('button', { name: 'Calcular pela Marinha' }).click();
  await expect(measures.getByRole('status')).toContainText('16,9 %');
  await measures.getByRole('button', { name: 'Salvar Medidas' }).click();
  await expect(
    measuresSection.getByRole('button', { name: 'Medidas e Gordura Corporal 16,9 %' }),
  ).toBeVisible();

  if (!(await profileSection.getByRole('button', { name: 'Editar Perfil' }).isVisible())) {
    await profileSection.getByRole('button').click();
  }
  await profileSection.getByRole('button', { name: 'Editar Perfil' }).click();
  const editProfile = page.getByRole('dialog', { name: 'Seu Perfil' });
  await editProfile.getByLabel('Data de nascimento').fill('2014-06-15');
  await expect(editProfile.getByRole('status')).toContainText('menores de 18 anos');
  await editProfile.getByRole('button', { name: 'Salvar Perfil' }).click();
  await expect(profileSection.getByRole('status')).toContainText('menores de 18 anos');
  await measuresSection.getByRole('button', { name: 'Registrar Medidas' }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Registrar Medidas e Gordura' })
      .getByRole('button', { name: 'Calcular pela Marinha' }),
  ).toHaveCount(0);
});
