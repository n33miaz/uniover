import { expect, test } from '../fixtures';
import { SEED_EXERCISE_IDS } from './support/training-seed';
import {
  openTraining,
  startTraining,
  waitForCatalog,
  expectOfflineIcon,
} from './support/training-pages';
import {
  listChip,
  openMap,
  panel,
  panelRows,
  seedExampleWeek,
  showFace,
  tapZone,
  tileBoxes,
  touchOwners,
  zone,
} from './body-map-kit';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const libraryRows = (page: import('@playwright/test').Page) => page.locator('.list .ui-row .name');

test.describe('mapa do corpo: da figura à lista', () => {
  test('abre pela lista, vira para Costas, toca no músculo e cai na lista já filtrada', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    await page.getByRole('link', { name: 'Mapa do Treino' }).click();
    await expect(page).toHaveURL(/\/treino\/exercicios\/mapa$/);
    await expect(page.getByRole('heading', { name: 'Mapa do Treino' })).toBeVisible();

    await showFace(page, 'Costas');
    await expect(page).toHaveURL(/face=back/);
    await tapZone(page, 'lats');
    await expect(panel(page).getByRole('heading', { name: 'Dorsais' })).toBeVisible();
    await expect(panelRows(page)).toHaveText([
      'Puxada supinada na polia',
      'Remada unilateral com halter',
    ]);

    await panel(page)
      .getByRole('link', { name: /^Ver todos \(2\)/ })
      .click();
    await expect(page).toHaveURL(/\/treino\/exercicios\?muscle=lats$/);
    await expect(libraryRows(page)).toHaveText([
      'Puxada supinada na polia',
      'Remada unilateral com halter',
    ]);
    await expect(
      page.getByRole('button', { name: /Tirar o filtro de músculo: Dorsais/ }),
    ).toBeVisible();
  });

  test('voltar da lista filtrada traz o mapa na mesma face e com o painel aberto', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openMap(page);
    await showFace(page, 'Costas');
    await tapZone(page, 'lats');
    await panel(page)
      .getByRole('link', { name: /^Ver todos \(2\)/ })
      .click();
    await expect(page).toHaveURL(/\/treino\/exercicios\?muscle=lats$/);

    await page.goBack();
    await expect(page).toHaveURL(/\/mapa\?face=back&muscle=lats$/);
    await expect(page.getByRole('button', { name: 'Costas', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(zone(page, 'lats')).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(page).getByRole('heading', { name: 'Dorsais' })).toBeVisible();
  });

  test('o painel mostra os três primeiros exercícios e leva à lista inteira (peito: 5)', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openMap(page);
    await tapZone(page, 'chest');
    await expect(panelRows(page)).toHaveCount(3);
    const all = panel(page).getByRole('link', { name: 'Ver todos (5)' });
    await expect(all).toHaveAttribute('href', '/treino/exercicios?muscle=chest');
    await all.click();
    await expect(libraryRows(page)).toHaveCount(5);
  });

  test('uma linha do painel abre a ficha do exercício, e voltar traz o painel aberto', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openMap(page);
    await tapZone(page, 'biceps');
    await panel(page)
      .getByRole('link', { name: /Rosca direta com barra/ })
      .click();
    await expect(page).toHaveURL(new RegExp(`/treino/exercicios/${SEED_EXERCISE_IDS.curl}$`));
    await expect(page.getByRole('heading', { name: 'Rosca direta com barra' })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/mapa\?muscle=biceps$/);
    await expect(panel(page).getByRole('heading', { name: 'Bíceps' })).toBeVisible();
  });

  test('pela lista de músculos: o mesmo painel, e um músculo das costas vira a figura', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openMap(page);
    await listChip(page, 'biceps').click();
    await expect(panel(page).getByRole('heading', { name: 'Bíceps' })).toBeVisible();
    await expect(zone(page, 'biceps')).toHaveAttribute('aria-pressed', 'true');
    await panel(page).getByRole('link', { name: 'Ver todos (1)' }).click();
    await expect(libraryRows(page)).toHaveText(['Rosca direta com barra']);
    await page.goBack();

    await listChip(page, 'lats').click();
    await expect(page.getByRole('button', { name: 'Costas', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(zone(page, 'lats')).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(page).getByRole('heading', { name: 'Dorsais' })).toBeVisible();
  });

  test('a lista traz todos os músculos, com a contagem; pescoço e adutores, sem exercício no catálogo, dizem zero', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openMap(page);
    await expect(page.locator('app-muscle-list .chip')).toHaveCount(17);
    await expect(listChip(page, 'chest')).toHaveAccessibleName('Peitoral 5 exercícios');
    await expect(listChip(page, 'neck')).toHaveAccessibleName('Pescoço 0 exercícios');
    await listChip(page, 'neck').click();
    await expect(panel(page).getByRole('heading', { name: 'Pescoço' })).toBeVisible();
    await expect(
      panel(page).getByText('Nenhum exercício deste músculo no catálogo.'),
    ).toBeVisible();
    await expect(panel(page).getByRole('link', { name: /Ver todos/ })).toHaveCount(0);
  });

  test('o endereço traz a face e o músculo: abrir direto já mostra o painel', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openMap(page, '?face=back&muscle=middle_back');
    await expect(zone(page, 'middle_back')).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(page).getByRole('heading', { name: 'Meio das costas' })).toBeVisible();
    await expect(panelRows(page)).toHaveText(['Remada sentada na polia']);
  });
});

test.describe('mapa do corpo: teclado e leitor de tela', () => {
  test('Enter e Espaço escolhem a zona em foco, e o foco aparece na forma', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openMap(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await zone(page, 'chest').focus();
    // Um passo para trás e outro para a frente: o foco passa a ser o do teclado (é o que o anel de foco acompanha).
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(zone(page, 'chest')).toBeFocused();
    // O foco é visível: o anel por baixo da forma acende e o contorno engrossa.
    await expect
      .poll(() =>
        zone(page, 'chest')
          .locator('.halo')
          .first()
          .evaluate((el) => getComputedStyle(el).strokeOpacity),
      )
      .toBe('0.4');
    await page.keyboard.press('Enter');
    await expect(zone(page, 'chest')).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(page).getByRole('heading', { name: 'Peitoral' })).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(zone(page, 'biceps')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(zone(page, 'biceps')).toHaveAttribute('aria-pressed', 'true');
    await expect(zone(page, 'chest')).toHaveAttribute('aria-pressed', 'false');
    await expect(panel(page).getByRole('heading', { name: 'Bíceps' })).toBeVisible();
  });

  test('cada zona tem nome com o músculo, a contagem de exercícios e as séries da semana', async ({
    page,
    context,
  }) => {
    const server = await startTraining(context, page);
    seedExampleWeek(server);
    await openMap(page);
    await expect(zone(page, 'chest')).toHaveAttribute(
      'aria-label',
      'Peitoral, 5 exercícios, 12 séries nesta semana',
    );
    await expect(zone(page, 'biceps')).toHaveAttribute(
      'aria-label',
      'Bíceps, 1 exercício, 2 séries nesta semana',
    );
    await expect(zone(page, 'abdominals')).toHaveAttribute(
      'aria-label',
      'Abdômen, 2 exercícios, Nenhuma série nesta semana',
    );
    await expect(page.getByRole('group', { name: 'Corpo, de frente' })).toBeVisible();
  });

  test('o nome do músculo escolhido é anunciado em texto', async ({ page, context }) => {
    await startTraining(context, page);
    await openMap(page);
    await tapZone(page, 'quadriceps');
    await expect(page.getByRole('status').filter({ hasText: 'Quadríceps' })).toHaveText(
      'Quadríceps: 2 exercícios, Nenhuma série nesta semana',
    );
  });
});

test.describe('mapa do corpo: volume da semana', () => {
  test('sem treino registrado o desenho é neutro e o painel diz isso sem alarme', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openMap(page);
    await expect(page.locator('.figure .zone:not([data-level="0"])')).toHaveCount(0);
    await tapZone(page, 'chest');
    const chip = panel(page).locator('.ui-chip');
    await expect(chip).toHaveText('Nenhuma série nesta semana');
    await expect(chip).not.toHaveClass(/accent/);
  });

  test('as séries da semana pintam a zona por degrau, com o número no painel e na legenda', async ({
    page,
    context,
  }) => {
    const server = await startTraining(context, page);
    seedExampleWeek(server);
    await openMap(page);
    // Peito: 8 + 4 séries (10 ou mais); bíceps: 2 (1 a 3); quadríceps: 3 (1 a 3); abdômen: nenhuma.
    await expect(zone(page, 'chest')).toHaveAttribute('data-level', '3');
    await expect(zone(page, 'biceps')).toHaveAttribute('data-level', '1');
    await expect(zone(page, 'quadriceps')).toHaveAttribute('data-level', '1');
    await expect(zone(page, 'abdominals')).toHaveAttribute('data-level', '0');
    await expect(page.locator('.legend .step')).toHaveText(['0', '1–3', '4–9', '10+']);

    await tapZone(page, 'chest');
    await expect(panel(page).locator('.ui-chip')).toHaveText('12 séries nesta semana');

    await showFace(page, 'Costas');
    // Dorsais: 5 séries do exercício do wger; meio das costas: 6 (4 a 9).
    await expect(zone(page, 'lats')).toHaveAttribute('data-level', '2');
    await expect(zone(page, 'middle_back')).toHaveAttribute('data-level', '2');
    await expect(zone(page, 'triceps')).toHaveAttribute('data-level', '0');
  });
});

test.describe('mapa do corpo: sem rede', () => {
  test('já aberto o app, o mapa funciona com o que está no aparelho', async ({ page, context }) => {
    const server = await startTraining(context, page);
    seedExampleWeek(server);
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    // Com rede, o aparelho traz o catálogo e o treino da semana; só então a rede cai.
    await page.getByRole('link', { name: 'Mapa do Treino' }).click();
    await expect(zone(page, 'chest')).toHaveAttribute('data-level', '3');
    await page.locator('app-page-top-bar .back').click();
    await expect(page).toHaveURL(/\/treino\/exercicios$/);
    await expect(page.getByText('Sem rede')).toHaveCount(0);

    server.offline = true;
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expectOfflineIcon(page);

    await page.getByRole('link', { name: 'Mapa do Treino' }).click();
    await expect(zone(page, 'chest')).toHaveAttribute(
      'aria-label',
      'Peitoral, 5 exercícios, 12 séries nesta semana',
    );
    await tapZone(page, 'chest');
    await expect(panelRows(page)).toHaveCount(3);
    await showFace(page, 'Costas');
    await tapZone(page, 'lats');
    await expect(panelRows(page)).toHaveText([
      'Puxada supinada na polia',
      'Remada unilateral com halter',
    ]);
    await expect(page.getByText('O Catálogo Ainda Não Chegou')).toHaveCount(0);
  });

  test('o catálogo que ainda não chegou tem o mesmo aviso da lista de Exercícios', async ({
    page,
    context,
  }) => {
    const server = await startTraining(context, page, { catalog: false });
    server.offline = true;
    await openTraining(page, '/treino/exercicios/mapa');
    await expect(page.getByText('O Catálogo Ainda Não Chegou')).toBeVisible();
    await expect(
      page.getByText('Na primeira abertura o aparelho baixa os exercícios.'),
    ).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByText('Sem rede, o aparelho ainda não tem os exercícios.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tentar Baixar' })).toBeVisible();
    await expect(page.locator('.figure')).toHaveCount(0);
  });
});

test.describe('mapa do corpo: área de toque', () => {
  test('as áreas de toque de cada face têm tamanho de dedo e nenhuma disputa o toque com a vizinha', async ({
    page,
    context,
  }, info) => {
    await startTraining(context, page);
    await openMap(page);
    const report: string[] = [];

    for (const face of ['Frente', 'Costas'] as const) {
      await showFace(page, face);
      await expect(
        page.getByRole('group', { name: face === 'Frente' ? /de frente/ : /de costas/ }),
      ).toBeVisible();
      const boxes = await tileBoxes(page);
      expect(boxes.length).toBeGreaterThan(8);

      // Piso: nenhuma área de toque abaixo de 24 px nos dois lados (o mínimo de alvo da WCAG 2.2). Os músculos grandes chegam
      // a 44 px (conferidos abaixo); os demais ficam entre 24 e 44 px, e a lista de músculos logo abaixo da figura os alcança
      // com alvos de 44 px. As medidas de cada zona saem nas anotações do teste.
      for (const box of boxes) {
        expect(Math.min(box.width, box.height), `${face} ${box.muscle}`).toBeGreaterThanOrEqual(24);
      }
      const best = new Map<string, number>();
      for (const box of boxes) {
        best.set(box.muscle, Math.max(best.get(box.muscle) ?? 0, Math.min(box.width, box.height)));
      }
      for (const [muscle, side] of best) report.push(`${face} ${muscle}: ${Math.round(side)} px`);
      const large =
        face === 'Frente'
          ? ['chest', 'shoulders', 'abdominals', 'forearms', 'quadriceps', 'calves']
          : ['traps', 'shoulders', 'forearms', 'calves'];
      for (const muscle of large) {
        expect(best.get(muscle), `${face} ${muscle}`).toBeGreaterThanOrEqual(44);
      }

      for (const { muscle, hits } of await touchOwners(page)) {
        expect(new Set(hits), `${face} ${muscle}`).toEqual(new Set([muscle]));
      }
    }
    info.annotations.push({ type: 'menor lado da área de toque', description: report.join(' | ') });
    // Para revisar a mão: as medidas de cada zona neste viewport.
    if (process.env['TRAINING_SHOTS_DIR']) console.log([info.project.name, ...report].join('\n'));
  });
});
