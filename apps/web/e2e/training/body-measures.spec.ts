import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { expectSynced, openTraining, startTraining } from './support/training-pages';

test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

const goOffline = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('offline')));
const goOnline = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('online')));

/** Abre a folha de medidas, preenche os campos pelo rótulo (exato) e salva. */
async function registerMeasures(
  page: Page,
  day: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  await page.getByRole('button', { name: /^Medidas\b/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Registrar Medidas e Gordura' });
  await sheet.getByLabel('Dia').fill(day);
  for (const [label, value] of Object.entries(values)) {
    await sheet.getByLabel(label, { exact: true }).fill(value);
  }
  await sheet.getByRole('button', { name: 'Salvar Medidas' }).click();
  await expect(sheet).toBeHidden();
}

const FIRST = {
  Tórax: '96',
  'Braço D': '35',
  'Braço E': '33,5',
  'Coxa D': '58',
  'Coxa E': '58,2',
  'Panturrilha D': '38',
  'Panturrilha E': '38',
  Peitoral: '10',
};

const SECOND = {
  Tórax: '98',
  'Braço D': '35',
  'Braço E': '34',
  'Coxa D': '57',
  'Coxa E': '58,2',
  'Panturrilha D': '38,5',
  'Panturrilha E': '38,5',
};

/** Espera a folha parar de subir ou descer (a animação de entrada e saída) antes de medir ou rodar o axe. */
async function settled(page: Page, name: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name });
  let last = '';
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      const now = JSON.stringify(box);
      const stable = now === last;
      last = now;
      return stable;
    })
    .toBe(true);
}

const mapPanel = (page: Page) => page.locator('app-body-map-panel');
/** O cartão de simetria de uma região, achado pelo começo do texto ("Braços" não pode pegar "Antebraços"). */
const sideCard = (page: Page, region: string) =>
  mapPanel(page).locator('.side-card', { hasText: new RegExp(`^\\s*${region}`) });
const tapZone = (page: Page, muscle: string) =>
  mapPanel(page).locator(`.zone[data-muscle="${muscle}"] .tile`).first().click();

test('a folha de medidas agrupa direito e esquerdo lado a lado, sem rolagem lateral', async ({
  page,
  context,
}) => {
  await startTraining(context, page);
  await openTraining(page, '/treino/corpo');
  await page.getByRole('button', { name: 'Entendi' }).click();
  await page.getByRole('button', { name: /^Medidas\b/ }).click();

  const sheet = page.getByRole('dialog', { name: 'Registrar Medidas e Gordura' });
  for (const group of ['Tronco (cm)', 'Braços (cm)', 'Pernas (cm)', 'Dobras (mm)']) {
    await expect(sheet.getByRole('group', { name: group })).toBeVisible();
  }

  // Direito e esquerdo na mesma linha: mesma altura, esquerdo à direita do direito (com a folha já parada).
  await settled(page, 'Registrar Medidas e Gordura');
  const right = await sheet.getByLabel('Braço D', { exact: true }).boundingBox();
  const left = await sheet.getByLabel('Braço E', { exact: true }).boundingBox();
  expect(right).not.toBeNull();
  expect(left).not.toBeNull();
  expect(Math.abs(right!.y - left!.y)).toBeLessThan(2);
  expect(left!.x).toBeGreaterThan(right!.x + right!.width - 1);

  // A folha e a página não rolam para o lado.
  const overflow = await sheet.evaluate((dialog) => dialog.scrollWidth - dialog.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoHorizontalScroll(page);

  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
});

test('registra as medidas novas com D e E, vê o mapa evoluir e abre o histórico tocando na região', async ({
  page,
  context,
}) => {
  await startTraining(context, page);
  await openTraining(page, '/treino/corpo');
  await page.getByRole('button', { name: 'Entendi' }).click();

  await expect(mapPanel(page).getByRole('heading', { name: 'Mapa do Corpo' })).toBeVisible();
  await registerMeasures(page, '2026-09-01', FIRST);

  // O cartão de Medidas não diz "Sem Registros" quando há medidas sem cintura: mostra a primeira registrada.
  await expect(page.locator('.signal-card').first()).toContainText('Tórax · 01/09/2026');

  // Com uma medição só o mapa não inventa evolução: diz o que falta, e a simetria já aparece.
  await expect(
    mapPanel(page).getByText('Registre outra medição para ver a evolução.'),
  ).toBeVisible();
  await expect(mapPanel(page).getByRole('list', { name: 'Legenda do mapa' })).toHaveCount(0);
  // Localiza o cartão pela região (os valores mudam a cada medição) e confere o nome da primeira.
  const arms = sideCard(page, 'Braços');
  await expect(arms).toHaveAccessibleName(
    /Braços.*direito 35,0\s+cm, esquerdo 33,5\s+cm, direito maior em 1,5\s+cm/,
  );
  await expect(sideCard(page, 'Panturrilhas')).toHaveAccessibleName(/lados próximos/);

  // Tocar no cartão de simetria abre o histórico daquela medida, com D e E.
  await arms.click();
  const history = page.getByRole('dialog', { name: 'Histórico de Braços' });
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await expect(history).toContainText('01/09/2026');
  await expect(history).toContainText('Direito');
  await expect(history).toContainText('Esquerdo');
  await expect(history.getByText(/35,0\s+cm/)).toBeVisible();
  await expect(history.getByText(/33,5\s+cm/)).toBeVisible();
  await history.getByRole('button', { name: 'Fechar' }).click();
  await expect(history).toBeHidden();

  // A segunda medição liga o mapa de calor: legenda e a região pintada com texto acessível.
  await registerMeasures(page, '2026-10-01', SECOND);
  await expect(mapPanel(page).getByRole('list', { name: 'Legenda do mapa' })).toBeVisible();
  await expect(mapPanel(page).getByRole('button', { name: 'Tórax: cresceu' })).toHaveCount(1);
  await expect(mapPanel(page).locator('.zone[data-muscle="chest"]')).toHaveAttribute(
    'data-level',
    '3',
  );
  await expect(mapPanel(page).getByRole('button', { name: 'Coxas: diminuiu' })).toHaveCount(1);
  await expect(mapPanel(page).getByRole('button', { name: 'Abdômen: sem comparação' })).toHaveCount(
    1,
  );

  // Tocar na região da silhueta abre a evolução dela, da medição mais nova para a mais antiga.
  await tapZone(page, 'chest');
  const chest = page.getByRole('dialog', { name: 'Histórico de Tórax' });
  await expect(chest.getByRole('listitem')).toHaveCount(2);
  await expect(chest.getByRole('listitem').first()).toContainText('01/10/2026');
  await expect(chest.getByRole('listitem').first()).toContainText(/98,0\s+cm/);
  await expect(chest.getByRole('listitem').first()).toContainText(/\+2,0\s+cm/);
  await chest.getByRole('button', { name: 'Fechar' }).click();

  // O histórico dos braços mostra as duas medidas e a variação de cada lado.
  await arms.click();
  const armsHistory = page.getByRole('dialog', { name: 'Histórico de Braços' });
  await expect(armsHistory.getByRole('listitem')).toHaveCount(2);
  await expect(armsHistory.getByRole('listitem').first()).toContainText(/\+0,5\s+cm/);
  await armsHistory.getByRole('button', { name: 'Fechar' }).click();

  // Frente e costas alternam; só as regiões medidas existem em cada face.
  await mapPanel(page).getByRole('button', { name: 'Costas' }).click();
  await expect(
    mapPanel(page).getByRole('group', { name: 'Mapa do corpo, de costas' }),
  ).toBeVisible();
  await expect(mapPanel(page).getByRole('button', { name: 'Panturrilhas: cresceu' })).toHaveCount(
    1,
  );
  await tapZone(page, 'calves');
  const calves = page.getByRole('dialog', { name: 'Histórico de Panturrilhas' });
  await expect(calves).toContainText(/38,5\s+cm/);
  // Do histórico dá para registrar uma medida nova.
  await calves.getByRole('button', { name: 'Registrar Medidas' }).click();
  await expect(page.getByRole('dialog', { name: 'Registrar Medidas e Gordura' })).toBeVisible();
  await expect(calves).toHaveCount(0);

  await page.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
});

test('o mapa sem nenhuma medida nova fica neutro e não abre cartões de simetria', async ({
  page,
  context,
}) => {
  await startTraining(context, page);
  await openTraining(page, '/treino/corpo');
  await page.getByRole('button', { name: 'Entendi' }).click();

  await expect(
    mapPanel(page).getByText('Registre outra medição para ver a evolução.'),
  ).toBeVisible();
  await expect(mapPanel(page).getByRole('heading', { name: 'Direito × Esquerdo' })).toHaveCount(0);

  // Medida só do lado direito: o cartão aparece pedindo o outro lado, sem diferença inventada.
  await registerMeasures(page, '2026-10-01', { 'Braço D': '35' });
  await expect(sideCard(page, 'Braços')).toHaveAccessibleName(/Registre os dois lados/);
});

test('registra sem rede, guarda no aparelho e envia as medidas novas uma vez quando a rede volta', async ({
  page,
  context,
}) => {
  const server = await startTraining(context, page);
  await openTraining(page, '/treino/corpo');
  await page.getByRole('button', { name: 'Entendi' }).click();
  server.offline = true;
  await goOffline(page);

  await registerMeasures(page, '2026-10-01', { Tórax: '98', 'Braço D': '35', 'Braço E': '33,5' });
  expect(server.writes('body-entries')).toBe(0);

  // Recarrega ainda sem rede: as medidas vêm do aparelho e o mapa continua mostrando a simetria.
  await page.goto('/treino/corpo');
  await expect(page.locator('app-training-page')).toBeVisible();
  await expect(sideCard(page, 'Braços')).toHaveAccessibleName(/direito 35,0\s+cm/);

  server.offline = false;
  await goOnline(page);
  await expect.poll(() => server.writes('body-entries')).toBe(1);
  await expectSynced(page);

  const puts = server.hits.filter(
    (hit) => hit.method === 'PUT' && hit.path.startsWith('body/entries/'),
  );
  expect(puts.filter((hit) => hit.outcome === 'executed')).toHaveLength(1);
  expect(new Set(puts.map((hit) => hit.key)).size).toBe(1);
  const [stored] = server.rows('body-entries');
  expect(stored).toMatchObject({ chestCm: 98, armRightCm: 35, armLeftCm: 33.5, deleted: false });
  // O que não foi medido segue vazio no envio (nada de zero no lugar de vazio).
  expect(stored['forearmRightCm']).toBeNull();
  expect(stored['chestSkinfoldMm']).toBeNull();
});
