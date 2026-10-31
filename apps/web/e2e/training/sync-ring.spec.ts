import { expect, test } from '../fixtures';
import { expectNoA11yViolations, settle } from '../screens/screen-helpers';
import { seedBenchHistory } from './support/today-seed';
import { beginWorkout, installClock, openToday, stubDevice } from './support/today-pages';
import { chooseMuscle, openTraining, startTraining } from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

test('o anel fica colado à esquerda dos três pontos, na mesma pílula, e cada um tem o seu toque', async ({
  page,
  context,
}) => {
  await installClock(page);
  await stubDevice(page, { vibrate: true });
  const server = await startTraining(context, page);
  seedBenchHistory(server);
  await openToday(page);
  await beginWorkout(page);

  const pill = page.locator('app-page-top-bar [pageTopBarActions]');
  const menu = pill.getByRole('button', { name: 'Mais opções' });
  await expect(menu).toBeVisible();
  await expect(pill.locator('.ring')).toHaveCount(0);

  // Sem rede o anel aparece (cinza) dentro da pílula, à esquerda do menu.
  server.offline = true;
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  const ring = pill.locator('.ring');
  await expect(ring).toHaveAttribute('data-state', 'offline');
  const ringBox = (await ring.boundingBox())!;
  const menuBox = (await menu.boundingBox())!;
  const pillBox = (await pill.boundingBox())!;
  expect(ringBox.width).toBeGreaterThanOrEqual(44);
  expect(ringBox.height).toBeGreaterThanOrEqual(44);
  expect(menuBox.width).toBeGreaterThanOrEqual(44);
  expect(menuBox.height).toBeGreaterThanOrEqual(44);
  expect(ringBox.x + ringBox.width).toBeLessThanOrEqual(menuBox.x + 1);
  expect(ringBox.x).toBeGreaterThanOrEqual(pillBox.x - 1);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(pillBox.x + pillBox.width + 1);

  // O anel só explica o estado: nada de botão de sincronizar, e "Tentar de Novo" é só do erro.
  await ring.click();
  const sheet = page.getByRole('dialog', { name: 'Sincronização' });
  await expect(sheet).toContainText('Sem rede');
  await expect(sheet.getByRole('button', { name: 'Tentar de Novo' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Sincronizar/ })).toHaveCount(0);
  await settle(page);
  await expectNoA11yViolations(page);
  await sheet.getByRole('button', { name: 'Fechar' }).click();
  await expect(sheet).toHaveCount(0);

  // O menu é outro toque, e os problemas de sincronização não moram mais nele.
  await menu.click();
  const options = page.getByRole('dialog', { name: 'Opções' });
  await expect(options).toBeVisible();
  await expect(options.getByRole('button', { name: /Sincroniza/ })).toHaveCount(0);
});

test('o anel conclui o estado e some depois de cerca de três segundos', async ({
  page,
  context,
}) => {
  await page.clock.install();
  const server = await startTraining(context, page);
  await openTraining(page, '/treino');
  server.offline = true;
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  const ring = page.locator('app-page-top-bar .ring');
  await expect(ring).toHaveAttribute('data-state', 'offline');
  server.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(ring).toHaveAttribute('data-state', 'ok');
  await page.clock.fastForward(2900);
  await expect(ring).toBeVisible();
  await page.clock.fastForward(300);
  await expect(ring).toHaveCount(0);
});

test('com envio pendente o anel mostra o número, e a folha conta o que falta sem oferecer sincronizar', async ({
  page,
  context,
}) => {
  const server = await startTraining(context, page);
  // O servidor não consegue gravar agora (5xx): o item fica na fila, com rede, esperando a próxima tentativa.
  server.failNext({ method: 'PUT', path: /^exercises\//, status: 503, times: 20 });
  await openTraining(page, '/treino/exercicios/novo');
  await page.getByLabel('Nome').fill('Remada na máquina articulada');
  await chooseMuscle(page, 'Meio das costas');
  await page.getByRole('button', { name: 'Salvar Exercício' }).click();
  const ring = page.locator('app-page-top-bar .ring');
  await expect(ring).toHaveAttribute('data-state', 'pending');
  await expect(ring).toHaveAccessibleName(/1 alteração aguardando envio/);
  await expect(ring.locator('text')).toHaveText('1');
  await ring.click();
  const sheet = page.getByRole('dialog', { name: 'Sincronização' });
  await expect(sheet).toContainText('Aguardando envio');
  await expect(sheet.getByRole('button', { name: 'Tentar de Novo' })).toHaveCount(0);
});
