import { Page } from '@playwright/test';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { PROGRESS_EXERCISE_IDS } from './progress-seed';
import {
  chart,
  chartPixels,
  expectChartDrawn,
  openProgress,
  startProgress,
  tableRows,
} from './progress-support';
import { section } from './progress-states';
import { openTraining } from './support/training-pages';
import { SEED_EXERCISE_IDS } from './support/training-seed';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker. O fuso é o de Brasília: o
// histórico semeado e as datas esperadas valem nele.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

const value = (page: Page) => page.locator('app-progress-evolution .value');
const when = (page: Page) => page.locator('app-progress-evolution .when');
const delta = (page: Page) => page.locator('app-progress-evolution .delta');
const pressed = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true, pressed: true });

test.describe('gráfico de evolução', () => {
  test('abre em 1RM estimado nas últimas 8 semanas, com o último ponto em destaque', async ({
    page,
    context,
  }) => {
    await startProgress(context, page);
    await openProgress(page);

    // 45 × 6 em 19/10: Epley 45 × (1 + 6/30) = 54. Do primeiro dia (02/09, 43,33) a 54 são 10,67.
    await expect(value(page)).toHaveText('54 kg');
    await expect(when(page)).toHaveText('19/10 · maior carga 45 kg × 6');
    await expect(delta(page)).toHaveText('+10,7 kg desde 02/09');
    await expect(pressed(page, '1RM estimado')).toBeVisible();
    await expect(pressed(page, '8 semanas')).toBeVisible();
    const evolutionBeforeSections = await page.locator('.progress').evaluate((progress) => {
      const evolution = progress.querySelector('app-progress-evolution')!;
      const sections = progress.querySelector('.sections')!;
      return Boolean(
        evolution.compareDocumentPosition(sections) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    expect(evolutionBeforeSections).toBe(true);
    await expect(chart(page)).toHaveAttribute(
      'aria-label',
      'Gráfico de linha: 1RM estimado de Supino reto com barra nas últimas 8 semanas. ' +
        '8 pontos, de 43,3 kg em 02/09 a 54 kg em 19/10.',
    );
    await expectChartDrawn(page);
    await expectNoHorizontalScroll(page);
  });

  test('a tabela de dados traz os mesmos 8 pontos do gráfico, do mais novo ao mais antigo', async ({
    page,
    context,
  }) => {
    await startProgress(context, page);
    await openProgress(page);

    const rows = await tableRows(page);

    expect(rows).toEqual([
      ['19/10', '54 kg', '45 kg × 6'],
      ['14/10', '53,8 kg', '42,5 kg × 8'],
      ['07/10', '53,8 kg', '42,5 kg × 8'],
      ['30/09', '53,3 kg', '40 kg × 10'],
      ['23/09', '50,7 kg', '40 kg × 8'],
      ['16/09', '50 kg', '37,5 kg × 10'],
      ['09/09', '46,7 kg', '35 kg × 10'],
      ['02/09', '43,3 kg', '32,5 kg × 10'],
    ]);
    await expect(chart(page)).toHaveAttribute('aria-label', /8 pontos/);
  });

  test('os períodos mudam o recorte: 8 semanas, 6 meses e tudo', async ({ page, context }) => {
    await startProgress(context, page);
    await openProgress(page);
    expect(await tableRows(page)).toHaveLength(8);

    await page.getByRole('button', { name: '6 meses', exact: true }).click();
    // 10/06 entra (dentro de 6 meses, fora de 8 semanas): 9 dias. A variação passa a contar de lá.
    await expect(page.locator('app-progress-evolution tbody tr')).toHaveCount(9);
    await expect(delta(page)).toHaveText('+14 kg desde 10/06');
    await expect(chart(page)).toHaveAttribute('aria-label', /nos últimos 6 meses\. 9 pontos/);

    await page.getByRole('button', { name: 'Tudo', exact: true }).click();
    await expect(page.locator('app-progress-evolution tbody tr')).toHaveCount(10);
    await expect(delta(page)).toHaveText('+14 kg desde 10/02');
    await expect(chart(page)).toHaveAttribute('aria-label', /em todo o histórico\. 10 pontos/);

    await page.getByRole('button', { name: '8 semanas', exact: true }).click();
    await expect(page.locator('app-progress-evolution tbody tr')).toHaveCount(8);
    await expect(delta(page)).toHaveText('+10,7 kg desde 02/09');
    await expectChartDrawn(page);
  });

  test('a carga máxima troca o valor, a tabela e a nota, e some o botão da meta de 1RM', async ({
    page,
    context,
  }) => {
    await startProgress(context, page);
    await openProgress(page);
    await expect(page.getByRole('button', { name: 'Definir Meta' })).toBeVisible();

    await page.getByRole('button', { name: 'Carga máxima', exact: true }).click();

    await expect(value(page)).toHaveText('45 kg');
    await expect(when(page)).toHaveText('19/10 · 6 repetições');
    await expect(delta(page)).toHaveText('+12,5 kg desde 02/09');
    await expect(page.getByText('Maior carga de cada dia, em séries de trabalho.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Definir Meta' })).toHaveCount(0);
    expect((await tableRows(page))[0]).toEqual(['19/10', '45 kg', '6']);
    await expectChartDrawn(page);
  });

  test('as setas e o toque no gráfico andam de ponto em ponto', async ({ page, context }) => {
    await startProgress(context, page);
    await openProgress(page);
    await expect(value(page)).toHaveText('54 kg');
    await expect(page.getByRole('button', { name: 'Próximo ponto' })).toBeDisabled();

    await page.getByRole('button', { name: 'Ponto anterior' }).click();
    await expect(value(page)).toHaveText('53,8 kg');
    await expect(when(page)).toContainText('14/10');

    // Um toque à esquerda de tudo escolhe o primeiro ponto (02/09, 43,3 kg).
    await chart(page).click({ position: { x: 45, y: 90 } });
    await expect(value(page)).toHaveText('43,3 kg');
    await expect(when(page)).toContainText('02/09');
    await expect(page.getByRole('button', { name: 'Ponto anterior' })).toBeDisabled();
  });

  test('a meta aparece como linha tracejada com rótulo, grava uma vez por mudança e some ao remover', async ({
    page,
    context,
  }) => {
    const server = await startProgress(context, page);
    await openProgress(page);
    await expectChartDrawn(page);
    // Sem meta, nenhum pixel da cor da meta.
    expect((await chartPixels(page, ['--a-warn']))['--a-warn']).toBe(0);

    await page.getByRole('button', { name: 'Definir Meta' }).click();
    const sheet = page.getByRole('dialog', { name: 'Meta de 1RM · Supino reto com barra' });
    await expect(sheet).toBeVisible();
    await sheet.getByLabel('Meta de 1RM, em kg').fill('55');
    await sheet.getByRole('button', { name: 'Salvar' }).click();
    await expect(sheet).toHaveCount(0);

    await expect(page.getByRole('button', { name: /^Meta: 55 kg/ })).toBeVisible();
    await expect(chart(page)).toHaveAttribute('aria-label', /Meta de 55 kg\.$/);
    await expect
      .poll(async () => (await chartPixels(page, ['--a-warn']))['--a-warn'])
      .toBeGreaterThan(40);
    await expect.poll(() => server.writes('goals')).toBe(1);
    const puts = () =>
      server.hits.filter(
        (hit) =>
          hit.method === 'PUT' && hit.path === 'goals/exercise_e1rm' && hit.outcome === 'executed',
      );
    expect(puts()).toHaveLength(1);

    // Trocar o valor é uma escrita; remover é outra (a lápide).
    await page.getByRole('button', { name: /^Meta: 55 kg/ }).click();
    await sheet.getByLabel('Meta de 1RM, em kg').fill('60');
    await sheet.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByRole('button', { name: /^Meta: 60 kg/ })).toBeVisible();
    await expect.poll(() => server.writes('goals')).toBe(2);

    await page.getByRole('button', { name: /^Meta: 60 kg/ }).click();
    await sheet.getByRole('button', { name: 'Remover Meta' }).click();
    await expect(page.getByRole('button', { name: 'Definir Meta' })).toBeVisible();
    await expect(chart(page)).not.toHaveAttribute('aria-label', /Meta de/);
    await expect.poll(() => server.writes('goals')).toBe(3);
    expect(puts()).toHaveLength(3);
    await expect.poll(async () => (await chartPixels(page, ['--a-warn']))['--a-warn']).toBe(0);
  });

  test('a meta é só do exercício em que foi definida', async ({ page, context }) => {
    await startProgress(context, page);
    await openProgress(page);
    await page.getByRole('button', { name: 'Definir Meta' }).click();
    const sheet = page.getByRole('dialog', { name: /^Meta de 1RM/ });
    await sheet.getByLabel('Meta de 1RM, em kg').fill('55');
    await sheet.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByRole('button', { name: /^Meta: 55 kg/ })).toBeVisible();

    await page.getByRole('button', { name: 'Agachamento livre com barra', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Definir Meta' })).toBeVisible();
    await expect(chart(page)).not.toHaveAttribute('aria-label', /Meta de/);
  });

  test('a sheet recusa o que o servidor recusaria e diz o motivo, sem gravar', async ({
    page,
    context,
  }) => {
    const server = await startProgress(context, page);
    await openProgress(page);
    await page.getByRole('button', { name: 'Definir Meta' }).click();
    const sheet = page.getByRole('dialog', { name: /^Meta de 1RM/ });

    await sheet.getByLabel('Meta de 1RM, em kg').fill('2000');
    await sheet.getByRole('button', { name: 'Salvar' }).click();
    await expect(sheet.getByRole('alert')).toHaveText('Use de 1 a 1.000 kg.');
    await sheet.getByLabel('Meta de 1RM, em kg').fill('abc');
    await sheet.getByRole('button', { name: 'Salvar' }).click();
    await expect(sheet.getByRole('alert')).toHaveText('Digite um número, como 55 ou 42,5.');
    expect(server.writes('goals')).toBe(0);
  });
});

test.describe('recordes', () => {
  test('batem com a conta feita à mão, e a linha fechada já diz o essencial', async ({
    page,
    context,
  }) => {
    await startProgress(context, page);
    await openProgress(page);

    const header = section(page, /^Recordes/);
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(header).toContainText('Carga máx. 45 kg · 1RM 54 kg');

    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    const rows = page.locator('app-progress-records .row');
    await expect(rows).toHaveCount(4);
    // 45 × 6 é o maior peso e o maior 1RM (54); o maior treino em volume foi 19/10 (3 × 45 × 6 = 810), à frente de 14/10 (740);
    // a carga mais usada nos últimos quatro treinos é 45 kg (3 séries), e o máximo de repetições com ela é 6.
    await expect(rows.locator('.title')).toHaveText([
      'Carga máxima',
      '1RM estimado',
      'Maior volume em um treino',
      'Mais repetições com 45 kg',
    ]);
    await expect(rows.locator('.value')).toHaveText(['45 kg × 6', '54 kg', '810 kg', '6']);
    await expect(rows.locator('.detail')).toHaveText([
      '19/10',
      '19/10 · de 45 kg × 6',
      '19/10 · 3 séries',
      '19/10',
    ]);
    // Tudo foi batido no último dia treinado: todos com o selo.
    await expect(rows.locator('.ui-chip')).toHaveText(['Recorde', 'Recorde', 'Recorde', 'Recorde']);
    await expect(
      page.getByText('carga que você mais usou nos últimos quatro treinos'),
    ).toBeVisible();
  });
});

test.describe('exercício, poucos dados e sem dados', () => {
  test('sem o endereço, abre no exercício treinado mais recentemente, com os outros em chips', async ({
    page,
    context,
  }) => {
    await startProgress(context, page);
    await openProgress(page, '/treino/progresso');

    const chips = page.getByRole('group', { name: 'Exercício do gráfico' }).getByRole('button');
    await expect(chips).toHaveText([
      'Agachamento livre com barra',
      'Supino reto com barra',
      'Remada sentada na polia',
      'Elevação lateral com halteres',
    ]);
    await expect(
      page.getByRole('button', { name: 'Agachamento livre com barra', pressed: true }),
    ).toBeVisible();
  });

  test('um treino só mostra o ponto e diz que faltam dados para uma linha', async ({
    page,
    context,
  }) => {
    await startProgress(context, page);
    await openProgress(page, `/treino/progresso?exercise=${PROGRESS_EXERCISE_IDS.squat}`);

    // 60 × 8 em 20/10: 60 × (1 + 8/30) = 76.
    await expect(value(page)).toHaveText('76 kg');
    await expect(
      page.getByText('Só um treino neste período: ainda faltam dados para traçar uma linha.'),
    ).toBeVisible();
    await expect(delta(page)).toHaveCount(0);
    await expect(chart(page)).toHaveAttribute('aria-label', /Um ponto: 76 kg em 20\/10\./);
    await expectChartDrawn(page);
  });

  test('um exercício sem registro explica o que falta, sem quadro vazio, e leva a Hoje', async ({
    page,
    context,
  }) => {
    await startProgress(context, page);
    await openProgress(page, `/treino/progresso?exercise=${SEED_EXERCISE_IDS.plank}`);

    await expect(page.getByText('Sem registro deste exercício ainda.')).toBeVisible();
    await expect(chart(page)).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Período do gráfico' })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Prancha isométrica', pressed: true }),
    ).toBeVisible();
    // As seções continuam: a semana e o calendário valem para o exercício que for.
    await expect(section(page, /^Semana/)).toBeVisible();

    await page
      .locator('app-progress-evolution')
      .getByRole('link', { name: 'Ir para Hoje' })
      .click();
    await expect(page).toHaveURL(/\/treino$/);
  });

  test('sem nenhum treino registrado, só explica o que fazer', async ({ page, context }) => {
    await startProgress(context, page, { history: false });
    await openTraining(page, '/treino/progresso');

    await expect(
      page.getByRole('heading', { name: 'Registre um Treino para Ver o Progresso' }),
    ).toBeVisible();
    await expect(page.locator('app-progress-evolution')).toHaveCount(0);
    await page.getByRole('link', { name: 'Ir para Hoje' }).click();
    await expect(page).toHaveURL(/\/treino$/);
  });

  test('um exercício sem 1RM possível (séries de mais de 10 repetições) oferece a carga máxima', async ({
    page,
    context,
  }) => {
    const server = await startProgress(context, page);
    // Remada com 15 repetições: tem carga, não tem 1RM (a estimativa só vale de 1 a 10 repetições).
    for (const row of server.rows('sets')) {
      if (row['exerciseId'] === PROGRESS_EXERCISE_IDS.row) row['reps'] = 15;
    }
    await openProgress(page, `/treino/progresso?exercise=${PROGRESS_EXERCISE_IDS.row}`);

    await expect(
      page.getByText(
        'Nenhuma série de 1 a 10 repetições neste período: o 1RM não pode ser estimado.',
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Ver a Carga Máxima' }).click();
    await expect(value(page)).toHaveText('50 kg');
    await expect(chart(page)).toBeVisible();
  });
});

test.describe('sem rede', () => {
  test('se o pedaço do gráfico não chega, a tela avisa, mantém os dados na tabela e desenha ao tentar de novo', async ({
    page,
    context,
  }) => {
    // Só o pedaço da biblioteca de gráficos é barrado (o resto da tela vem normal): reconhece-se pelo conteúdo, que tem as
    // classes `u-` dela (o pedaço da tela também cita `u-wrap`, nos estilos do componente, por isso o marcador é uma classe
    // que só a biblioteca tem). É a mesma falha de uma rede que cai no meio do download.
    let blocked = true;
    await page.route(/\/chunk-[\w-]+\.js$/, async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      if (blocked && body.includes('u-cursor-pt')) return route.abort('failed');
      return route.fulfill({ response, body });
    });
    await startProgress(context, page);
    await openProgress(page);

    await expect(page.getByText('Não foi possível carregar o gráfico agora.')).toBeVisible();
    await expect(value(page)).toHaveText('54 kg');
    await expect(chart(page)).toHaveCount(0);
    // Os mesmos pontos estão na tabela, que a tela abre sozinha nesse caso.
    expect(await tableRows(page)).toHaveLength(8);

    blocked = false;
    await page.getByRole('button', { name: 'Tentar de Novo' }).click();
    await expect(chart(page)).toBeVisible();
    await expectChartDrawn(page);
    await expect(page.getByText('Não foi possível carregar o gráfico agora.')).toHaveCount(0);
  });

  test('o gráfico, os períodos e a tabela funcionam depois de a tela abrir, porque tudo vem do aparelho', async ({
    page,
    context,
  }) => {
    const server = await startProgress(context, page);
    await openProgress(page);
    await expect(value(page)).toHaveText('54 kg');
    // A biblioteca do gráfico é um pedaço à parte, baixado quando o gráfico é desenhado. Sem o service worker (este teste o
    // bloqueia) a rede é a única fonte dele: só depois de o desenho aparecer vale cortar a rede, senão o teste mede a
    // corrida entre o pedaço chegar e a rede cair, e não o que ele diz (o dado e o gráfico já abertos não precisam dela).
    await expectChartDrawn(page);

    server.offline = true;
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));

    await page.getByRole('button', { name: '6 meses', exact: true }).click();
    await expect(delta(page)).toHaveText('+14 kg desde 10/06');
    expect(await tableRows(page)).toHaveLength(9);
    await page.getByRole('button', { name: 'Carga máxima', exact: true }).click();
    await expect(value(page)).toHaveText('45 kg');
    await expectChartDrawn(page);
    await context.setOffline(false);
  });
});
