import { expect, test } from '../fixtures';
import { openTraining, startTraining } from '../training/support/training-pages';

test.use({ serviceWorkers: 'block' });

test('registra peso, acompanha tendência e salva gordura e medidas com perfil', async ({
  page,
  context,
}) => {
  await startTraining(context, page);
  await openTraining(page, '/treino/corpo');
  await page.getByRole('button', { name: 'Entendi' }).click();
  await expect(
    page.getByText('Registre seu primeiro peso para acompanhar como ele muda ao longo do tempo.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Registrar peso' }).click();
  const dialog = page.getByRole('dialog', { name: 'Registrar peso' });
  await dialog.getByLabel('Peso (kg)').fill('82,4');
  await dialog.getByLabel('Dia').fill('2026-10-20');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.locator('.latest .value')).toHaveText('82,4 kg');

  await page.getByRole('button', { name: 'Registrar peso' }).click();
  const next = page.getByRole('dialog', { name: 'Registrar peso' });
  await next.getByLabel('Peso (kg)').fill('81,4');
  await next.getByLabel('Dia').fill('2026-10-21');
  await next.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.locator('.delta strong')).toHaveText('−0,1 kg');

  await page.getByRole('button', { name: 'Editar pesagem de 21/10/2026, 81,4 kg' }).click();
  const edit = page.getByRole('dialog', { name: 'Pesagem de 21/10' });
  await edit.getByLabel('Peso (kg)').fill('81,8');
  await edit.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.locator('.latest .value')).toHaveText('81,8 kg');

  const profileSection = page.locator('app-body-section').nth(1);
  if (!(await profileSection.getByRole('button', { name: 'Preencher perfil' }).isVisible())) {
    await profileSection.getByRole('button').click();
  }
  await profileSection.getByRole('button', { name: 'Preencher perfil' }).click();
  const profile = page.getByRole('dialog', { name: 'Seu perfil' });
  await profile.getByLabel('Altura (cm)').fill('180');
  await profile.getByLabel('Data de nascimento').fill('1995-06-15');
  await profile.getByRole('radio', { name: 'Feminino' }).check();
  await profile.getByRole('radio', { name: 'Masculino' }).check();
  await profile.getByRole('radio', { name: '1,9' }).check();
  await profile.getByRole('button', { name: 'Salvar perfil' }).click();
  await expect(profileSection.getByRole('button', { name: /Perfil 180 cm/ })).toBeVisible();

  const measuresSection = page.locator('app-body-section').nth(2);
  if (!(await measuresSection.getByRole('button', { name: 'Registrar medidas' }).isVisible())) {
    await measuresSection.getByRole('button').click();
  }
  await measuresSection.getByRole('button', { name: 'Registrar medidas' }).click();
  const measures = page.getByRole('dialog', { name: 'Registrar gordura e medidas' });
  await measures.getByLabel('Cintura / abdômen (cm)').fill('86');
  await measures.getByLabel('Pescoço (cm)').fill('38');
  await measures.getByRole('radio', { name: 'Bioimpedância' }).check();
  await measures.getByRole('radio', { name: 'Informado por você' }).check();
  await measures.getByRole('button', { name: 'Calcular pela Marinha' }).click();
  await expect(measures.getByRole('status')).toContainText('16,9 %');
  await measures.getByRole('button', { name: 'Salvar medidas' }).click();
  await expect(
    measuresSection.getByRole('button', { name: 'Gordura e medidas 16,9 %' }),
  ).toBeVisible();

  if (!(await profileSection.getByRole('button', { name: 'Editar perfil' }).isVisible())) {
    await profileSection.getByRole('button').click();
  }
  await profileSection.getByRole('button', { name: 'Editar perfil' }).click();
  const editProfile = page.getByRole('dialog', { name: 'Seu perfil' });
  await editProfile.getByLabel('Data de nascimento').fill('2014-06-15');
  await expect(editProfile.getByRole('status')).toContainText('menores de 18 anos');
  await editProfile.getByRole('button', { name: 'Salvar perfil' }).click();
  await expect(profileSection.getByRole('status')).toContainText('menores de 18 anos');
  await measuresSection.getByRole('button', { name: 'Registrar medidas' }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Registrar gordura e medidas' })
      .getByRole('button', { name: 'Calcular pela Marinha' }),
  ).toHaveCount(0);
});
