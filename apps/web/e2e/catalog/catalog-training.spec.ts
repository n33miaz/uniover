import { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { PROGRESS_EXERCISE_IDS } from '../training/progress-seed';
import { BENCH_URL, openProgress, startProgress } from '../training/progress-support';
import { installClock, openToday, beginWorkout } from '../training/support/today-pages';
import {
  seedBenchHistory,
  seedOpenElsewhere,
  seedSupersetRoutine,
  HOURS,
} from '../training/support/today-seed';
import { SEED_EXERCISE_IDS, SEED_ROUTINE_IDS } from '../training/support/training-seed';
import { openTraining, startTraining, waitForCatalog } from '../training/support/training-pages';
import { recordGap, snap } from './catalog-kit';
import { calm, still, waitSkeleton } from './catalog-setup';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

const M = 'Treino';

/** O banco local do Treino abre devagar: o `success` do pedido de abertura chega depois de `delay` ms (a espera com esqueleto). */
async function slowTrainingDb(page: Page, delay: number): Promise<void> {
  await page.addInitScript((ms) => {
    const original = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess');
    if (!original?.set) return;
    Object.defineProperty(IDBRequest.prototype, 'onsuccess', {
      configurable: true,
      get: original.get,
      set(handler: ((event: Event) => unknown) | null) {
        if (typeof handler === 'function' && this instanceof IDBOpenDBRequest) {
          const delayed = function (this: IDBRequest, event: Event) {
            setTimeout(() => handler.call(this, event), ms);
          };
          original.set!.call(this, delayed);
        } else {
          original.set!.call(this, handler);
        }
      },
    });
  }, delay);
}

/** Abre uma tela do Treino pelo endereço e espera a casca e o esqueleto saírem. */
async function show(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator('app-training-page').waitFor({ state: 'attached' });
  await calm(page);
}

test('Exercícios e Rotinas: biblioteca, ficha, formulários e rotinas', async ({
  context,
  page,
}) => {
  const server = await startTraining(context, page);
  void server;
  const lib = { module: M, route: '/treino/exercicios', url: '/treino/exercicios' };
  await snap(page, { ...lib, state: 'lista', kind: 'com dados' }, async () => {
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
  });
  await snap(page, { ...lib, state: 'lista', kind: 'com dados', scheme: 'dark' }, async () => {
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
  });
  await snap(page, { ...lib, state: 'filtros: peito e barra', kind: 'com dados' }, async () => {
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    await page.getByRole('button', { name: 'Peito', exact: true }).click();
    await page.getByRole('button', { name: 'Equipamento' }).click();
    await page.getByRole('button', { name: 'Barra', exact: true }).click();
    // A lista filtra um instante depois do toque: só sobra exercício de barra.
    await expect
      .poll(async () => {
        const rows = await page.locator('.list .ui-row').allTextContents();
        return rows.length > 0 && rows.every((row) => row.includes('Barra'));
      })
      .toBe(true);
    await still(page);
  });
  await snap(page, { ...lib, state: 'busca com resultado', kind: 'com dados' }, async () => {
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    await page.getByRole('searchbox', { name: 'Buscar exercício' }).fill('supino');
    await expect(page.locator('.list .ui-row').first()).toContainText(/supino/i);
    await still(page);
  });
  await snap(page, { ...lib, state: 'busca sem resultado', kind: 'vazio' }, async () => {
    await openTraining(page, '/treino/exercicios');
    await waitForCatalog(page);
    await page.getByRole('searchbox', { name: 'Buscar exercício' }).fill('zzzz');
    await expect(page.locator('.list .ui-row')).toHaveCount(0);
    await still(page);
  });

  const map = { module: M, route: '/treino/exercicios/mapa', url: '/treino/exercicios/mapa' };
  await snap(page, { ...map, state: 'mapa do corpo', kind: 'padrão' }, () => show(page, map.url));
  const glossary = { module: M, route: '/treino/glossario', url: '/treino/glossario' };
  await snap(page, { ...glossary, state: 'glossário', kind: 'padrão' }, () =>
    show(page, glossary.url),
  );

  const novo = { module: M, route: '/treino/exercicios/novo', url: '/treino/exercicios/novo' };
  await snap(page, { ...novo, state: 'formulário vazio', kind: 'padrão' }, () =>
    show(page, novo.url),
  );
  await snap(page, { ...novo, state: 'com erro de validação', kind: 'validação' }, async () => {
    await show(page, novo.url);
    await page.getByLabel('Nome').fill('Remada');
    await page.getByText('Escolha o músculo principal.').waitFor();
  });

  const detail = (id: string) => `/treino/exercicios/${id}`;
  const ficha = { module: M, route: '/treino/exercicios/:id' };
  await snap(
    page,
    { ...ficha, url: detail(SEED_EXERCISE_IDS.bench), state: 'com ilustração', kind: 'com dados' },
    () => show(page, detail(SEED_EXERCISE_IDS.bench)),
  );
  await snap(
    page,
    {
      ...ficha,
      url: detail(SEED_EXERCISE_IDS.bench),
      state: 'com ilustração',
      kind: 'com dados',
      scheme: 'dark',
    },
    () => show(page, detail(SEED_EXERCISE_IDS.bench)),
  );
  await snap(
    page,
    { ...ficha, url: detail(SEED_EXERCISE_IDS.plank), state: 'sem ilustração', kind: 'com dados' },
    () => show(page, detail(SEED_EXERCISE_IDS.plank)),
  );
  await snap(
    page,
    {
      ...ficha,
      url: detail(SEED_EXERCISE_IDS.wger),
      state: 'de fonte aberta, com autor e licença',
      kind: 'com dados',
    },
    () => show(page, detail(SEED_EXERCISE_IDS.wger)),
  );
  await snap(
    page,
    {
      ...ficha,
      url: detail(SEED_EXERCISE_IDS.pushUp),
      state: 'folha "Adicionar a um treino"',
      kind: 'folha',
    },
    async () => {
      await show(page, detail(SEED_EXERCISE_IDS.pushUp));
      await page.getByRole('button', { name: 'Adicionar a um Treino' }).click();
      await page.getByRole('dialog', { name: 'Adicionar a um Treino' }).waitFor();
    },
  );
  await snap(
    page,
    { ...ficha, url: detail('nao-existe'), state: 'exercício que não existe', kind: 'erro' },
    () => show(page, detail('nao-existe')),
  );
  await snap(
    page,
    {
      module: M,
      route: '/treino/exercicios/:id/editar',
      url: `${detail(SEED_EXERCISE_IDS.bench)}/editar`,
      state: 'edição de exercício do catálogo',
      kind: 'padrão',
    },
    () => show(page, `${detail(SEED_EXERCISE_IDS.bench)}/editar`),
  );

  const rotinas = { module: M, route: '/treino/rotinas', url: '/treino/rotinas' };
  await snap(page, { ...rotinas, state: 'lista', kind: 'com dados' }, () =>
    show(page, rotinas.url),
  );
  await snap(page, { ...rotinas, state: 'modelos prontos', kind: 'folha' }, async () => {
    await show(page, rotinas.url);
    await page.getByRole('button', { name: 'Comparar Modelos' }).click();
    await page.getByRole('button', { name: /Full body/ }).waitFor();
  });
  await snap(
    page,
    {
      module: M,
      route: '/treino/rotinas/nova',
      url: '/treino/rotinas/nova',
      state: 'rotina nova',
      kind: 'vazio',
    },
    () => show(page, '/treino/rotinas/nova'),
  );
  const editor = `/treino/rotinas/${SEED_ROUTINE_IDS.a}`;
  await snap(
    page,
    {
      module: M,
      route: '/treino/rotinas/:id',
      url: editor,
      state: 'editor com exercícios',
      kind: 'com dados',
    },
    () => show(page, editor),
  );
  await snap(
    page,
    {
      module: M,
      route: '/treino/rotinas/:id',
      url: editor,
      state: 'editor com exercícios',
      kind: 'com dados',
      scheme: 'dark',
    },
    () => show(page, editor),
  );
});

test('Treino: bibliotecas vazias e sem rede', async ({ context, page }) => {
  const server = await startTraining(context, page, { routines: false, catalog: false });
  server.offline = true;
  await snap(
    page,
    {
      module: M,
      route: '/treino/exercicios',
      url: '/treino/exercicios',
      state: 'catálogo ainda não chegou, sem rede',
      kind: 'sem rede',
    },
    () => show(page, '/treino/exercicios'),
  );
  await snap(
    page,
    {
      module: M,
      route: '/treino/rotinas',
      url: '/treino/rotinas',
      state: 'sem nenhuma rotina',
      kind: 'vazio',
    },
    () => show(page, '/treino/rotinas'),
  );
});

test('Treino: esqueletos de espera', async ({ context, page }) => {
  await startTraining(context, page);
  await slowTrainingDb(page, 6000);
  const waits: [string, string][] = [
    ['/treino', 'Hoje'],
    ['/treino/exercicios', 'exercícios'],
    ['/treino/progresso', 'progresso'],
    ['/treino/corpo', 'corpo'],
  ];
  for (const [route, name] of waits) {
    await snap(
      page,
      { module: M, route, url: route, state: `${name}: banco local abrindo`, kind: 'carregando' },
      async () => {
        await page.goto(route);
        await waitSkeleton(page);
      },
    );
  }
});

test('Hoje: início, treino em andamento e programas', async ({ context, page }) => {
  await installClock(page);
  const server = await startTraining(context, page);
  seedBenchHistory(server);
  const hoje = { module: M, route: '/treino', url: '/treino' };
  await snap(page, { ...hoje, state: 'com rotinas e histórico', kind: 'com dados' }, () =>
    openToday(page),
  );
  await snap(
    page,
    { ...hoje, state: 'com rotinas e histórico', kind: 'com dados', scheme: 'dark' },
    () => openToday(page),
  );
  await snap(
    page,
    {
      module: M,
      route: '/treino/sessao/exercicio',
      url: '/treino/sessao/exercicio',
      state: 'exercício em andamento',
      kind: 'com dados',
    },
    async () => {
      await openToday(page);
      await beginWorkout(page, /Treino/);
      await still(page);
    },
  );
  await snap(
    page,
    {
      module: M,
      route: '/treino/sessao/exercicio',
      url: '/treino/sessao/exercicio',
      state: 'exercício em andamento',
      kind: 'com dados',
      scheme: 'dark',
    },
    () => still(page),
  );
  await snap(
    page,
    {
      module: M,
      route: '/treino/sessao/exercicio',
      url: '/treino/sessao/exercicio',
      state: 'série concluída, descanso',
      kind: 'com dados',
    },
    async () => {
      await page.getByRole('button', { name: 'Concluir Série' }).click();
      await page.locator('app-rest-card').waitFor();
      await still(page);
    },
  );
  await snap(
    page,
    {
      module: M,
      route: '/treino/sessao',
      url: '/treino/sessao',
      state: 'lista do treino do dia',
      kind: 'com dados',
    },
    async () => {
      await page.goBack();
      await page.locator('app-workout-day').waitFor();
      await calm(page);
    },
  );
});

test('Hoje: treino aberto em outro aparelho e superséries', async ({ context, page }) => {
  await installClock(page);
  const server = await startTraining(context, page);
  seedBenchHistory(server);
  seedSupersetRoutine(server);
  seedOpenElsewhere(server, HOURS.one);
  await snap(
    page,
    {
      module: M,
      route: '/treino',
      url: '/treino',
      state: 'treino aberto em outro aparelho',
      kind: 'com dados',
    },
    () => openToday(page, { history: false }),
  );
});

test('Hoje: sem rotinas e sem histórico', async ({ context, page }) => {
  await installClock(page);
  await startTraining(context, page, { routines: false });
  await snap(
    page,
    {
      module: M,
      route: '/treino',
      url: '/treino',
      state: 'conta nova, sem rotinas',
      kind: 'vazio',
    },
    async () => {
      await openTraining(page, '/treino');
      await calm(page);
    },
  );
});

test('Progresso: com histórico e sem', async ({ context, page }) => {
  const server = await startProgress(context, page);
  void server;
  const p = { module: M, route: '/treino/progresso' };
  await snap(
    page,
    { ...p, url: BENCH_URL, state: 'supino, com histórico', kind: 'com dados' },
    async () => {
      await openProgress(page);
      await calm(page);
    },
  );
  await snap(
    page,
    { ...p, url: BENCH_URL, state: 'supino, com histórico', kind: 'com dados', scheme: 'dark' },
    () => calm(page),
  );
  const row = `/treino/progresso?exercise=${PROGRESS_EXERCISE_IDS.row}`;
  await snap(
    page,
    { ...p, url: row, state: 'remada, poucos treinos', kind: 'com dados' },
    async () => {
      await openProgress(page, row);
      await calm(page);
    },
  );
});

test('Progresso: sem nenhum treino', async ({ context, page }) => {
  await startProgress(context, page, { history: false });
  await snap(
    page,
    {
      module: M,
      route: '/treino/progresso',
      url: '/treino/progresso',
      state: 'sem histórico',
      kind: 'vazio',
    },
    async () => {
      await show(page, '/treino/progresso');
      await calm(page);
    },
  );
});

test('Corpo, avaliações e alimentação', async ({ context, page }) => {
  await startTraining(context, page);
  const corpo = { module: M, route: '/treino/corpo', url: '/treino/corpo' };
  await snap(page, { ...corpo, state: 'primeira vez (aviso de privacidade)', kind: 'vazio' }, () =>
    show(page, '/treino/corpo'),
  );
  await snap(page, { ...corpo, state: 'resumo, sem registros', kind: 'vazio' }, async () => {
    await show(page, '/treino/corpo');
    await page.getByRole('button', { name: 'Entendi' }).click();
    await expect(page.getByRole('button', { name: 'Entendi' })).toBeHidden();
    await calm(page);
  });
  await snap(page, { ...corpo, state: 'aba Registros', kind: 'vazio' }, async () => {
    await page.getByRole('button', { name: 'Registros', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Registros', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await calm(page);
  });
  await snap(page, { ...corpo, state: 'aba Fotos', kind: 'vazio' }, async () => {
    await page.getByRole('button', { name: 'Fotos' }).click();
    await expect(page.getByRole('button', { name: 'Fotos' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await calm(page);
  });
  await snap(page, { ...corpo, state: 'registrar peso', kind: 'folha' }, async () => {
    await page.getByRole('button', { name: 'Resumo' }).click();
    await page.getByRole('button', { name: 'Registrar Peso' }).click();
    await page.getByRole('dialog', { name: 'Registrar Peso' }).waitFor();
  });
  await snap(page, { ...corpo, state: 'com um peso registrado', kind: 'com dados' }, async () => {
    const weight = page.getByRole('dialog', { name: 'Registrar Peso' });
    await weight.getByLabel('Peso (kg)').fill('82,4');
    await weight.getByRole('button', { name: 'Salvar' }).click();
    await page.locator('.weight-card .weight-value').waitFor();
    await calm(page);
  });

  const a = { module: M, route: '/treino/corpo/avaliacoes' };
  await snap(
    page,
    { ...a, url: '/treino/corpo/avaliacoes', state: 'lista vazia', kind: 'vazio' },
    () => show(page, '/treino/corpo/avaliacoes'),
  );
  await snap(
    page,
    {
      module: M,
      route: '/treino/corpo/avaliacoes/nova',
      url: '/treino/corpo/avaliacoes/nova',
      state: 'formulário vazio',
      kind: 'padrão',
    },
    () => show(page, '/treino/corpo/avaliacoes/nova'),
  );
  await snap(
    page,
    {
      module: M,
      route: '/treino/corpo/avaliacoes/importar',
      url: '/treino/corpo/avaliacoes/importar',
      state: 'importar relatório',
      kind: 'padrão',
    },
    () => show(page, '/treino/corpo/avaliacoes/importar'),
  );
  await snap(
    page,
    {
      module: M,
      route: '/treino/corpo/avaliacoes/:id',
      url: '/treino/corpo/avaliacoes/sem-registro',
      state: 'avaliação que não existe',
      kind: 'erro',
    },
    () => show(page, '/treino/corpo/avaliacoes/sem-registro'),
  );
  await snap(
    page,
    {
      module: M,
      route: '/treino/corpo/avaliacoes/:id/editar',
      url: '/treino/corpo/avaliacoes/sem-registro/editar',
      state: 'edição de avaliação que não existe',
      kind: 'erro',
    },
    () => show(page, '/treino/corpo/avaliacoes/sem-registro/editar'),
  );
  await snap(
    page,
    {
      module: M,
      route: '/treino/alimentacao',
      url: '/treino/alimentacao',
      state: 'diário vazio',
      kind: 'vazio',
    },
    () => show(page, '/treino/alimentacao'),
  );
  recordGap(
    M,
    '/treino/corpo/avaliacoes/:id',
    'avaliação preenchida',
    'Os dados do Corpo ficam só no aparelho (sem API para semear): exigiria conduzir o formulário.',
  );
  recordGap(
    M,
    '/treino/alimentacao',
    'diário com refeições',
    'Sem semente de alimentos e refeições no simulador; só o estado vazio.',
  );
});
