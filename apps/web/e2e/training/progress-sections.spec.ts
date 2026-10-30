import { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { expect, test, waitForServiceWorkerControl } from '../fixtures';
import { expectChartDrawn, openProgress, startProgress, tableRows } from './progress-support';
import { trainingDbName } from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker. O fuso é o de Brasília: o
// histórico semeado e as datas esperadas valem nele.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

/** O botão que abre uma seção (o título e o resumo dela). Não confunde com as setas "Semana anterior" de dentro. */
const section = (page: Page, title: RegExp) => page.locator('button.toggle', { hasText: title });

/** Os nomes, os números e a largura de cada barra do volume por grupo muscular. */
async function bars(page: Page) {
  return page.locator('app-progress-week .bar').evaluateAll((items) =>
    items.map((item) => ({
      name: item.querySelector('.name')?.textContent?.trim(),
      count: Number(item.querySelector('.count')?.textContent?.trim()),
      width: item.querySelector('rect.fill')?.getAttribute('width'),
    })),
  );
}

test.describe('semana e volume por músculo', () => {
  test('a linha fechada diz a semana de hoje; aberta, mostra uma barra por grupo com o número real', async ({
    page,
    context,
  }) => {
    await startProgress(context, page);
    await openProgress(page);

    const header = section(page, /^Semana/);
    await expect(header).toContainText('2 treinos · 7 séries');
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await header.click();

    const week = page.locator('app-progress-week');
    await expect(week.locator('.range b')).toHaveText('18 a 24 de outubro');
    await expect(week.locator('.range span')).toHaveText('Esta semana');
    await expect(week.locator('.totals b')).toHaveText('2 treinos · 7 séries');
    await expect(week.locator('.totals span')).toHaveText('Semana anterior: 5 séries');
    // Supino (3 séries, peito) e agachamento (4, pernas): a barra mais longa é a de pernas; peito é 3 de 4.
    const rows = await bars(page);
    expect(rows).toEqual([
      { name: 'Peito', count: 3, width: '75' },
      { name: 'Costas', count: 0, width: '0' },
      { name: 'Pernas', count: 4, width: '100' },
      { name: 'Ombros', count: 0, width: '0' },
      { name: 'Braços', count: 0, width: '0' },
      { name: 'Abdômen', count: 0, width: '0' },
    ]);
    // O volume da semana fecha: as barras somam as 7 séries do total.
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(7);
    await expect(week).toContainText('Aquecimento não conta');
    await expect(week).toContainText('não recomenda quanto fazer');
  });

  test('anda de semana em semana, de domingo a sábado, e uma semana que cruza o mês leva os dois meses', async ({
    page,
    context,
  }) => {
    await startProgress(context, page);
    await openProgress(page);
    await section(page, /^Semana/).click();
    const week = page.locator('app-progress-week');
    const previous = week.getByRole('button', { name: 'Semana anterior' });
    const next = week.getByRole('button', { name: 'Próxima semana' });
    await expect(next).toBeDisabled();

    await previous.click();
    await expect(week.locator('.range b')).toHaveText('11 a 17 de outubro');
    await expect(week.locator('.range span')).toHaveText('Semana passada');
    await expect(week.locator('.totals b')).toHaveText('2 treinos · 5 séries');
    // Supino (2 séries) e remada (3 séries, costas).
    expect((await bars(page)).map((row) => [row.name, row.count, row.width]).slice(0, 2)).toEqual([
      ['Peito', 2, '66.7'],
      ['Costas', 3, '100'],
    ]);

    await previous.click();
    await expect(week.locator('.range b')).toHaveText('4 a 10 de outubro');
    await expect(week.locator('.totals b')).toHaveText('1 treino · 1 série');

    await previous.click();
    await expect(week.locator('.range b')).toHaveText('27 de setembro a 3 de outubro');
    await expect(week.locator('.totals b')).toHaveText('1 treino · 1 série');

    await next.click();
    await next.click();
    await next.click();
    await expect(week.locator('.range b')).toHaveText('18 a 24 de outubro');
    await expect(next).toBeDisabled();
  });

  test('a meta de treinos por semana é do dono: só aparece depois de definida, e grava uma vez', async ({
    page,
    context,
  }) => {
    const server = await startProgress(context, page);
    await openProgress(page);
    await section(page, /^Semana/).click();
    const week = page.locator('app-progress-week');
    await expect(week.locator('.goal-text span')).toHaveText('Sem meta: você define');
    await expect(week.locator('.totals b')).toHaveText('2 treinos · 7 séries');

    await week.getByRole('button', { name: 'Definir' }).click();
    const sheet = page.getByRole('dialog', { name: 'Meta de Treinos por Semana' });
    await sheet.getByLabel('Treinos por semana').fill('3');
    await sheet.getByRole('button', { name: 'Salvar' }).click();
    await expect(sheet).toHaveCount(0);

    await expect(week.locator('.totals b')).toHaveText('2 de 3 treinos · 7 séries');
    await expect(section(page, /^Semana/)).toContainText('2 de 3 treinos · 7 séries');
    await expect(week.locator('.goal-text span')).toHaveText('3 por semana');
    await expect.poll(() => server.writes('goals')).toBe(1);
    expect(
      server.hits.filter(
        (hit) =>
          hit.method === 'PUT' &&
          hit.path === 'goals/weekly_sessions' &&
          hit.outcome === 'executed',
      ),
    ).toHaveLength(1);
  });
});

test.describe('calendário de frequência', () => {
  test('marca os dias certos com uma forma cheia, hoje com contorno, e a constância das duas últimas semanas', async ({
    page,
    context,
  }) => {
    await startProgress(context, page);
    await openProgress(page);

    const header = section(page, /^Frequência/);
    await expect(header).toContainText('Outubro · 5 treinos');
    await header.click();

    const frequency = page.locator('app-progress-frequency');
    await expect(frequency.locator('.range b')).toHaveText('Outubro de 2026');
    await expect(frequency.locator('.range span')).toHaveText('5 treinos no mês');
    await expect(frequency.locator('.day.on')).toHaveText(['7', '14', '16', '19', '20']);
    await expect(frequency.locator('td[aria-label]')).toHaveCount(5);
    await expect(frequency.locator('td[aria-label]').first()).toHaveAttribute(
      'aria-label',
      'treino em 07/10',
    );
    // Hoje é 21 e não treinou: contorno, sem o círculo cheio, e anunciado como a data de hoje.
    await expect(frequency.locator('.day.today')).toHaveText('21');
    await expect(frequency.locator('.day.today.on')).toHaveCount(0);
    await expect(frequency.locator('td[aria-current="date"]')).toHaveCount(1);
    // Semana de domingo a sábado: 1º de outubro de 2026 é uma quinta-feira.
    await expect(frequency.locator('thead abbr')).toHaveText([
      'dom',
      'seg',
      'ter',
      'qua',
      'qui',
      'sex',
      'sáb',
    ]);
    const first = await frequency
      .locator('tbody tr')
      .first()
      .locator('td')
      .evaluateAll((cells) => cells.map((cell) => (cell.textContent ?? '').trim()));
    expect(first).toEqual(['', '', '', '', '1', '2', '3']);

    // As duas últimas semanas completas: 4 a 10/10 (1 treino) e 11 a 17/10 (2 treinos).
    await expect(frequency).toContainText(
      'Constância: entre 1 e 2 treinos por semana nas duas últimas semanas',
    );
    await expect(frequency).toContainText(
      'Sem meta de treinos por semana: você define na seção Semana.',
    );
  });

  test('vai ao mês anterior e volta, sem passar do mês de hoje', async ({ page, context }) => {
    await startProgress(context, page);
    await openProgress(page);
    await section(page, /^Frequência/).click();
    const frequency = page.locator('app-progress-frequency');
    const next = frequency.getByRole('button', { name: 'Próximo mês' });
    await expect(next).toBeDisabled();

    await frequency.getByRole('button', { name: 'Mês anterior' }).click();
    await expect(frequency.locator('.range b')).toHaveText('Setembro de 2026');
    await expect(frequency.locator('.day.on')).toHaveText(['2', '9', '16', '23', '30']);
    await expect(frequency.locator('.range span')).toHaveText('5 treinos no mês');
    await expect(frequency.locator('.day.today')).toHaveCount(0);

    await next.click();
    await expect(frequency.locator('.range b')).toHaveText('Outubro de 2026');
    await expect(next).toBeDisabled();
  });

  test('com a meta da semana definida, a constância mostra a meta e as semanas seguidas que a cumpriram', async ({
    page,
    context,
  }) => {
    await startProgress(context, page);
    await openProgress(page);
    await section(page, /^Semana/).click();
    await page.locator('app-progress-week').getByRole('button', { name: 'Definir' }).click();
    const sheet = page.getByRole('dialog', { name: 'Meta de Treinos por Semana' });
    await sheet.getByLabel('Treinos por semana').fill('2');
    await sheet.getByRole('button', { name: 'Salvar' }).click();
    await expect(sheet).toHaveCount(0);

    await section(page, /^Frequência/).click();
    // Semana de hoje (2 treinos) e a anterior (2) cumpriram; a de 4 a 10/10 (1) não.
    await expect(page.locator('app-progress-frequency')).toContainText(
      'Constância: entre 1 e 2 treinos por semana nas duas últimas semanas (meta: 2). 2 semanas seguidas com a meta',
    );
    await expect(page.locator('app-progress-frequency')).not.toContainText('Sem meta de treinos');
  });
});

/**
 * Abre a seção de exportar já com o histórico no aparelho: a primeira sincronização termina em paralelo com a tela abrir, e
 * exportar ou compartilhar no meio dela leria um aparelho ainda vazio (o resumo da semana é o primeiro a mostrar o histórico).
 */
async function openExport(page: Page) {
  await expect(section(page, /^Semana/)).toContainText('2 treinos · 7 séries');
  await section(page, /^Exportar e Compartilhar/).click();
}

/** Fixa o que o aparelho faz ao compartilhar e ao copiar: o teste lê o que o app mandou, sem abrir folha do sistema. */
async function stubDevice(page: Page, mode: 'sem-compartilhar' | 'compartilhar') {
  await page.addInitScript((deviceMode) => {
    const holder = window as unknown as { __copied: string[]; __shared: unknown[] };
    holder.__copied = [];
    holder.__shared = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void holder.__copied.push(text) },
    });
    if (deviceMode === 'compartilhar') {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data: unknown) => void holder.__shared.push(data),
      });
    } else {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    }
  }, mode);
}

const WEEK_TEXT = [
  'Treino: resumo da semana de 18/10 a 24/10',
  'Treinos: 2',
  'Séries de trabalho: 7',
  // 3 × 45 × 6 (supino) + 4 × 60 × 8 (agachamento) = 810 + 1.920.
  'Volume: 2.730 kg',
  'Recordes: Supino reto com barra (carga máxima, 1RM estimado)',
].join('\n');

test.describe('exportar e compartilhar', () => {
  test('o JSON traz tudo: os 12 treinos e as 23 séries do histórico, e as metas', async ({
    page,
    context,
  }, info) => {
    await stubDevice(page, 'sem-compartilhar');
    await startProgress(context, page);
    await openProgress(page);
    await openExport(page);

    // No Chromium o baixar arquivo dispara o evento `download`. No WebKit o que acontece fica registrado no relatório.
    const download = page.waitForEvent('download', { timeout: 10_000 }).catch(() => null);
    await page.getByRole('button', { name: /^Exportar Tudo \(JSON\)/ }).click();
    const file = await download;

    await expect(page.locator('app-progress-export')).toContainText(
      'Arquivo gerado: uniover-treino-2026-10-21.json.',
    );
    if (file === null) {
      expect(info.project.name).toBe('iphone-12');
      info.annotations.push({
        type: 'webkit-download',
        description:
          'o WebKit do Playwright não emitiu o evento download para a âncora com atributo download',
      });
      return;
    }
    expect(file.suggestedFilename()).toBe('uniover-treino-2026-10-21.json');
    const document = JSON.parse(await readFile((await file.path()) as string, 'utf8'));
    expect(document).toMatchObject({ app: 'uniover', module: 'training', exportVersion: 1 });
    expect(document.sections.sessions).toHaveLength(12);
    expect(document.sections.sets).toHaveLength(23);
    expect(document.sections.goals).toEqual([]);
    if (info.project.name === 'iphone-12') {
      info.annotations.push({
        type: 'webkit-download',
        description: 'o evento download chegou no WebKit',
      });
    }
  });

  test('o CSV abre em planilha: BOM, acento, aspas, vírgula e a fórmula =2+2 neutralizada', async ({
    page,
    context,
  }, info) => {
    await stubDevice(page, 'sem-compartilhar');
    await startProgress(context, page);
    await openProgress(page);
    await openExport(page);

    const download = page.waitForEvent('download', { timeout: 10_000 }).catch(() => null);
    await page.getByRole('button', { name: /^Exportar Séries \(CSV\)/ }).click();
    const file = await download;

    await expect(page.locator('app-progress-export')).toContainText(
      'Arquivo gerado: uniover-treino-2026-10-21.csv.',
    );
    if (file === null) {
      expect(info.project.name).toBe('iphone-12');
      info.annotations.push({
        type: 'webkit-download',
        description: 'o WebKit do Playwright não emitiu o evento download para o CSV',
      });
      return;
    }
    const bytes = await readFile((await file.path()) as string);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = bytes.toString('utf8').slice(1).split('\r\n');
    expect(lines[0]).toBe(
      'date,session_id,routine,exercise,set_type,weight_kg,reps,duration_s,rir,rpe,note',
    );
    // 23 séries e a linha final vazia depois do último CRLF.
    expect(lines).toHaveLength(1 + 23 + 1);
    const lateral = lines.filter((line) => line.includes('Elevação lateral com halteres'));
    expect(lateral).toHaveLength(3);
    // A anotação que começa com `=` ganha um apóstrofo; a que tem aspas e vírgula vai entre aspas, com as aspas dobradas.
    expect(lateral[0]).toMatch(/,8,12,,,,'=2\+2$/);
    expect(lateral[1]).toMatch(/,8,12,,,,"diz ""oi"", tudo bem"$/);
    expect(lines[1]).toMatch(/^2026-02-10,.*,Supino reto com barra,work,30,10,,,,$/);
  });

  test('o resumo da semana vai para o compartilhar do aparelho, quando ele existe', async ({
    page,
    context,
  }) => {
    await stubDevice(page, 'compartilhar');
    await startProgress(context, page);
    await openProgress(page);
    await openExport(page);

    await page.getByRole('button', { name: /^Compartilhar Resumo da Semana/ }).click();

    await expect(page.locator('app-progress-export')).toContainText(
      'Resumo enviado ao compartilhar do aparelho.',
    );
    const shared = await page.evaluate(
      () => (window as unknown as { __shared: { title: string; text: string }[] }).__shared,
    );
    expect(shared).toHaveLength(1);
    expect(shared[0].title).toBe('Resumo da semana');
    expect(shared[0].text).toBe(WEEK_TEXT);
  });

  test('sem compartilhar no aparelho, o resumo é copiado e o app diz isso', async ({
    page,
    context,
  }) => {
    await stubDevice(page, 'sem-compartilhar');
    await startProgress(context, page);
    await openProgress(page);
    await openExport(page);

    await page.getByRole('button', { name: /^Compartilhar Resumo da Semana/ }).click();

    await expect(page.locator('app-progress-export')).toContainText(
      'Este aparelho não abre o compartilhar: o resumo foi copiado, é só colar onde quiser.',
    );
    const copied = await page.evaluate(
      () => (window as unknown as { __copied: string[] }).__copied,
    );
    expect(copied).toEqual([WEEK_TEXT]);
  });

  test('sem compartilhar nem copiar, o app diz que não consegue e aponta o JSON e o CSV', async ({
    page,
    context,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    });
    await startProgress(context, page);
    await openProgress(page);
    await openExport(page);

    await page.getByRole('button', { name: /^Compartilhar Resumo da Semana/ }).click();

    await expect(page.locator('app-progress-export')).toContainText(
      'Este aparelho não consegue compartilhar nem copiar o texto. Use o JSON ou o CSV.',
    );
  });
});

test.describe('recarregar sem rede, com o service worker', () => {
  test.use({ serviceWorkers: 'allow' });

  // Aparelho que já teve uma sessão: a dica da última conta (que o app grava ao entrar) diz qual banco local abrir sem
  // esperar o `/me`.
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      localStorage.setItem('uniover.account-id', 'u1');
    });
  });

  // Grava linhas direto no banco local do Treino, como o puxador faria com o que o servidor entrega.
  async function putRows(page: Page, store: string, rows: Record<string, unknown>[]) {
    await page.evaluate(
      ({ store, rows, dbName }) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open(dbName);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction(store, 'readwrite');
            for (const row of rows) tx.objectStore(store).put(row);
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
      { store, rows, dbName: trainingDbName() },
    );
  }

  test('o gráfico, o resumo e a tabela voltam do aparelho, com a biblioteca de gráficos vinda do cache', async ({
    page,
    context,
  }) => {
    await page.goto('/treino/exercicios');
    await waitForServiceWorkerControl(page);
    await expect(page.locator('app-training-page')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          async (name) => ((await indexedDB.databases()) ?? []).some((db) => db.name === name),
          trainingDbName(),
        ),
      )
      .toBe(true);

    const now = Date.now();
    const day = 86_400_000;
    const exercise = {
      id: 'e1',
      slug: 'e1',
      source: 'free_exercise_db',
      sourceRef: 'e1',
      name: 'Supino reto',
      nameKey: 'supino reto',
      instructions: ['Faça o movimento.'],
      primaryMuscles: ['chest'],
      secondaryMuscles: [],
      equipment: 'barbell',
      recordType: 'weight_reps',
      stepKg: null,
      stepClientUpdatedAt: null,
      level: null,
      category: null,
      mechanic: null,
      license: null,
      licenseAuthor: null,
      licenseUrl: null,
      reviewed: true,
      updatedAt: 1,
      clientUpdatedAt: 1,
      deletedAt: null,
    };
    // Três treinos nas últimas semanas: 40 × 10, 42,5 × 8 e 45 × 6 (1RM de 53,3, 53,8 e 54).
    const history = [
      [17, 40, 10],
      [10, 42.5, 8],
      [3, 45, 6],
    ] as const;
    await putRows(page, 'exercises', [exercise]);
    await putRows(
      page,
      'sessions',
      history.map(([ago], index) => ({
        id: `s${index}`,
        routineId: null,
        startedAt: now - ago * day,
        finishedAt: now - ago * day + 3_000_000,
        note: '',
        feeling: null,
        deviceId: 'd',
        updatedAt: now - ago * day,
        clientUpdatedAt: now - ago * day,
        deletedAt: null,
      })),
    );
    await putRows(
      page,
      'sets',
      history.map(([ago, weightKg, reps], index) => ({
        id: `x${index}`,
        sessionId: `s${index}`,
        exerciseId: 'e1',
        position: 0,
        setType: 'work',
        weightKg,
        reps,
        durationS: null,
        rir: null,
        rpe: null,
        note: '',
        completedAt: now - ago * day + 60_000,
        updatedAt: now - ago * day,
        clientUpdatedAt: now - ago * day,
        deletedAt: null,
      })),
    );

    await context.setOffline(true);
    await page.goto('/treino/progresso?exercise=e1');
    await expect(page.getByRole('heading', { name: 'Evolução' })).toBeVisible();

    await expect(page.locator('app-progress-evolution .value')).toHaveText('54 kg');
    await expect(page.getByRole('img', { name: /^Gráfico de linha/ })).toHaveAttribute(
      'aria-label',
      /3 pontos, de 53,3 kg em \d\d\/\d\d a 54 kg em \d\d\/\d\d\./,
    );
    await expectChartDrawn(page);
    expect(await tableRows(page)).toHaveLength(3);
    await section(page, /^Semana/).click();
    await expect(page.locator('app-progress-week .bar')).toHaveCount(6);
    await context.setOffline(false);
  });
});
