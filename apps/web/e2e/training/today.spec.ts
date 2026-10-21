import { BrowserContext, Page } from '@playwright/test';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import {
  HOURS,
  OPEN_ELSEWHERE_ID,
  OTHER_DEVICE,
  seedBenchHistory,
  seedOpenElsewhere,
  seedPastWorkout,
} from './support/today-seed';
import {
  beginWorkout,
  concludeSet,
  deviceLog,
  fieldValue,
  installClock,
  menu,
  openToday,
  stubDevice,
  tap,
  DeviceStubs,
} from './support/today-pages';
import { SEED_EXERCISE_IDS } from './support/training-seed';
import { countRows, startTraining } from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const goOffline = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('offline')));
const goOnline = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('online')));

/** Relógio controlado, aparelhos falsos e o servidor de teste já com o histórico do supino. */
async function launch(
  context: BrowserContext,
  page: Page,
  options: { history?: boolean; stubs?: DeviceStubs } = {},
) {
  await installClock(page);
  await stubDevice(page, options.stubs ?? {});
  const server = await startTraining(context, page);
  if (options.history !== false) seedBenchHistory(server);
  return server;
}

/** O relógio do descanso ("1:45"). */
const restTime = (page: Page) => page.locator('.rest .time');

test.describe('Hoje', () => {
  test('o resumo da semana vem em cima, a rotina do dia embaixo, e o botão de iniciar fica acima da lista', async ({
    page,
    context,
  }) => {
    const server = await launch(context, page);
    // Um treino de dez minutos atrás: está sempre na semana de hoje (segunda a domingo).
    seedPastWorkout(server, 2, 10 * 60_000, [
      { exerciseId: SEED_EXERCISE_IDS.pushdown, weightKg: 25, reps: 12 },
      { exerciseId: SEED_EXERCISE_IDS.pushdown, weightKg: 25, reps: 12 },
    ]);
    await openToday(page);

    const week = page.locator('.week');
    const routine = page.locator('.routine');
    await expect(week.locator('.stat').nth(0)).toHaveText(/^Treinoss*1$/);
    await expect(week.locator('.stat').nth(1)).toHaveText(/^Sériess*2$/);
    // 25 kg × 12 × 2 séries = 600 kg.
    await expect(week.locator('.stat').nth(2)).toHaveText(/^Volumes*600 kg$/);

    const weekBox = (await week.boundingBox())!;
    const routineBox = (await routine.boundingBox())!;
    expect(weekBox.y).toBeLessThan(routineBox.y);

    await expect(
      routine.getByRole('heading', { name: 'Treino A · Peito e tríceps' }),
    ).toBeVisible();
    await expect(routine).toContainText('3 exercícios · 10 séries · cerca de');
    const start = page.getByRole('button', { name: 'Iniciar treino' });
    const startBox = (await start.boundingBox())!;
    const listBox = (await page.locator('.lines').boundingBox())!;
    expect(startBox.y).toBeLessThan(listBox.y);
    // O botão principal está na primeira tela do celular (390×664), sem rolar.
    expect(startBox.y + startBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);

    const rows = page.locator('.lines .ui-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('Supino reto com barra');
    await expect(rows.first()).toContainText('4 × 6–10 · última vez 40 kg × 10');
    await expect(rows.first()).toContainText('tente 42,5 kg');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await settle(page);
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    expect(await smallTargets(page)).toEqual([]);
  });

  test('"Escolher outra rotina" troca o cartão do dia, e a sequência segue a primeira da lista', async ({
    page,
    context,
  }) => {
    await launch(context, page);
    await openToday(page);

    await page.getByRole('button', { name: 'Escolher outra rotina' }).click();
    const dialog = page.getByRole('dialog', { name: 'Escolher outra rotina' });
    await expect(dialog.getByRole('button')).toHaveCount(3); // duas rotinas e o "Cancelar"
    await expect(dialog.getByText('próxima', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: /Treino B/ }).click();

    await expect(page.getByRole('heading', { name: 'Treino B · Costas e bíceps' })).toBeVisible();
    await expect(page.locator('.lines .ui-row').first()).toContainText('Puxada supinada na polia');
  });

  test('sem rotinas, a tela convida a montar uma e ainda deixa treinar sem rotina', async ({
    page,
    context,
  }) => {
    await installClock(page);
    await startTraining(context, page, { routines: false });
    await openToday(page, { history: false });

    await expect(page.getByRole('heading', { name: 'Sem rotinas ainda' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Montar rotinas' })).toHaveAttribute(
      'href',
      '/treino/rotinas',
    );
    await expect(page.getByRole('button', { name: 'Treino livre' })).toBeVisible();
  });

  test('treino aberto em outro aparelho bloqueia o início; passadas 12 horas, oferece encerrar o esquecido', async ({
    page,
    context,
  }) => {
    const server = await launch(context, page);
    seedOpenElsewhere(server, HOURS.three);
    await openToday(page, { history: false });

    await expect(
      page.getByRole('heading', { name: 'Treino aberto em outro aparelho' }),
    ).toBeVisible();
    await expect(page.getByText('aberto há 3 h')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Iniciar treino' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Encerrar o treino esquecido' })).toHaveCount(0);
    await expect(page.getByText('depois de 12 horas você poderá encerrá-lo daqui')).toBeVisible();
  });

  test('o treino esquecido há mais de 12 horas é encerrado daqui, e o início volta', async ({
    page,
    context,
  }) => {
    const server = await launch(context, page);
    seedOpenElsewhere(server, HOURS.thirteen);
    await openToday(page, { history: false });

    await expect(page.getByText('aberto há 13 h')).toBeVisible();
    await page.getByRole('button', { name: 'Encerrar o treino esquecido' }).click();
    await expect(page.getByText('Encerrar o treino do outro aparelho?')).toBeVisible();
    await page.getByRole('button', { name: 'Sim, encerrar' }).click();

    await expect(page.getByText('Treino esquecido encerrado')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Iniciar treino' })).toBeVisible();
    // O encerramento sobe pela fila: o servidor passa a ver o treino do outro aparelho como encerrado.
    await expect
      .poll(
        () => server.rows('sessions').find((row) => row.id === OPEN_ELSEWHERE_ID)?.['finishedAt'],
      )
      .not.toBeNull();
  });
});

test.describe('treino ao vivo', () => {
  test('abre na série 1, com a última vez já preenchida, a sugestão do dia e o motivo atrás de um toque', async ({
    page,
    context,
  }) => {
    await launch(context, page);
    await openToday(page);
    await beginWorkout(page);

    await expect(
      page.getByRole('heading', { level: 2, name: 'Supino reto com barra' }),
    ).toBeVisible();
    await expect(page.getByText('exercício 1 de 3 · série 1 de 4')).toBeVisible();
    await expect(fieldValue(page, 'Carga')).toHaveValue('40');
    await expect(fieldValue(page, 'Repetições')).toHaveValue('10');
    const hint = page.locator('app-focus-hint');
    await expect(hint).toContainText('Última vez');
    await expect(hint).toContainText('40 kg × 10');
    await expect(hint).toContainText('42,5 kg × 6–8');
    await expect(page.getByText('Você fechou o topo da faixa')).toHaveCount(0);
    await page.getByRole('button', { name: 'Por que esta sugestão?' }).click();
    await expect(page.getByText('Você fechou o topo da faixa na última vez')).toBeVisible();
    // O esforço (RPE) é opcional e a tela acesa nasce desligada.
    await expect(page.getByRole('button', { name: '8', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('o histórico que chega do servidor depois de iniciar entra no cartão que ainda ninguém mexeu', async ({
    page,
    context,
  }) => {
    const server = await launch(context, page, { history: false });
    await openToday(page, { history: false });
    await beginWorkout(page);
    await expect(page.getByText('Primeira vez neste exercício')).toBeVisible();
    await expect(fieldValue(page, 'Carga')).toHaveValue('');

    // O treino já subiu e a fila esvaziou; agora o servidor passa a ter o histórico, e a próxima leitura o traz.
    await expect.poll(() => server.writes('sessions')).toBe(1);
    await expect(page.getByText(/sincronizado às \d{2}:\d{2}/)).toBeVisible();
    seedBenchHistory(server);
    // O relógio da página só anda quando o teste manda: sem isto o carimbo da leitura seria o mesmo da anterior.
    await page.clock.fastForward(1000);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => countRows(page, 'sets')).toBe(4);
    await expect.poll(() => countRows(page, 'sessions')).toBe(2);
    // A leitura que trouxe os dados pode ter acabado no mesmo instante da anterior (o relógio da página só anda quando o
    // teste manda, e o aviso da tela segue o carimbo da leitura): mais uma, com o relógio andado, tem carimbo novo.
    await page.clock.fastForward(1000);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await expect(page.locator('app-focus-hint')).toContainText('40 kg × 10');
    await expect(fieldValue(page, 'Carga')).toHaveValue('40');
    await expect(fieldValue(page, 'Repetições')).toHaveValue('10');
  });

  test('os botões − e + andam pelo salto do exercício; os alvos de uso na academia têm 56 px ou mais', async ({
    page,
    context,
  }) => {
    await launch(context, page);
    await openToday(page);
    await beginWorkout(page);

    // Barra: salto de 2,5 kg. Repetições: de 1 em 1.
    await tap(page, 'Aumentar a carga');
    await expect(fieldValue(page, 'Carga')).toHaveValue('42,5');
    await tap(page, 'Diminuir as repetições', 2);
    await expect(fieldValue(page, 'Repetições')).toHaveValue('8');
    await tap(page, 'Diminuir a carga', 2);
    await expect(fieldValue(page, 'Carga')).toHaveValue('37,5');
    // Também se digita, com vírgula.
    await fieldValue(page, 'Carga').fill('41,25');
    await fieldValue(page, 'Carga').blur();
    await expect(fieldValue(page, 'Carga')).toHaveValue('41,25');

    for (const name of [
      'Aumentar a carga',
      'Diminuir a carga',
      'Aumentar as repetições',
      'Concluir série',
    ]) {
      const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(Math.min(box.width, box.height), name).toBeGreaterThanOrEqual(56);
    }
    // "Concluir série" fica ao alcance do polegar: colado na base da tela.
    const dock = (await page.getByRole('button', { name: 'Concluir série' }).boundingBox())!;
    expect(dock.y + dock.height).toBeGreaterThan(page.viewportSize()!.height - 40);
  });

  test('concluir a série grava, avisa o recorde (carga máxima e 1RM estimado) e inicia o descanso, que conta, soma 15 s e pula', async ({
    page,
    context,
  }) => {
    await launch(context, page, { stubs: { vibrate: true } });
    await openToday(page);
    await beginWorkout(page);

    await tap(page, 'Aumentar a carga');
    await tap(page, 'Diminuir as repetições', 2);
    await concludeSet(page);

    const record = page.getByRole('status').filter({ hasText: 'Recorde!' });
    await expect(record).toContainText('carga máxima 42,5 kg (antes 40 kg)');
    await expect(record).toContainText('1RM estimado 53,8 kg (antes 53,3 kg)');
    await expect(page.locator('.done .ui-chip', { hasText: 'recorde' })).toBeVisible();
    await expect(page.locator('.sub')).toContainText('série 2 de 4');

    // A série seguinte já vem com a mesma carga e as mesmas repetições.
    await expect(fieldValue(page, 'Carga')).toHaveValue('42,5');
    await expect(fieldValue(page, 'Repetições')).toHaveValue('8');

    // Descanso: o da linha da rotina (2:00), contando com o relógio da página.
    await expect(page.getByRole('heading', { name: 'Descanso' })).toBeVisible();
    await expect(restTime(page)).toHaveText(/^(2:00|1:5\d)$/);
    await expect(page.locator('.rest .goal')).toHaveText('meta 2:00');
    await page.clock.fastForward(30_000);
    await expect(restTime(page)).toHaveText(/^1:[23]\d$/);
    await page.getByRole('button', { name: '+15 s' }).click();
    await expect(restTime(page)).toHaveText(/^1:[45]\d$/);
    await page.getByRole('button', { name: 'Pular', exact: true }).click();
    await expect(page.locator('.rest')).toHaveCount(0);

    // Sem histórico anterior e com a mesma carga, a segunda série não repete o aviso.
    await concludeSet(page);
    await expect(page.getByRole('status').filter({ hasText: 'Recorde!' })).toHaveCount(0);
  });

  test('ao zerar, o descanso só vibra: nenhum som, e a tela mostra que terminou', async ({
    page,
    context,
  }) => {
    await launch(context, page, { stubs: { vibrate: true } });
    await openToday(page);
    await beginWorkout(page);
    await concludeSet(page);

    await expect(page.locator('.rest')).toBeVisible();
    expect((await deviceLog(page)).vibrations).toHaveLength(0);
    await page.clock.fastForward(125_000);

    await expect(page.getByRole('heading', { name: 'Descanso terminou' })).toBeVisible();
    await expect(page.getByText('Hora da próxima série.')).toBeVisible();
    await expect.poll(async () => (await deviceLog(page)).vibrations.length).toBeGreaterThan(0);
    // O áudio nunca é liberado nem criado: o aviso é só a vibração.
    expect((await deviceLog(page)).audioContexts).toBe(0);
    await page.getByRole('button', { name: 'Fechar', exact: true }).click();
    await expect(page.locator('.rest')).toHaveCount(0);
  });

  test('num aparelho que não vibra (iPhone), a tela diz isso e o fim do descanso fica claro na própria tela', async ({
    page,
    context,
  }) => {
    await launch(context, page, { stubs: { vibrate: false } });
    await openToday(page);
    await beginWorkout(page);
    await concludeSet(page);

    await expect(
      page.getByText('Este aparelho não vibra: olhe a tela quando o tempo acabar.'),
    ).toBeVisible();
    await page.clock.fastForward(125_000);
    await expect(page.getByRole('heading', { name: 'Descanso terminou' })).toBeVisible();
    await expect(page.locator('.rest.over')).toBeVisible();
    expect((await deviceLog(page)).audioContexts).toBe(0);
  });

  test('a tela acesa é um interruptor desligado por padrão: liga, pede de novo ao voltar à aba e desliga', async ({
    page,
    context,
  }) => {
    await launch(context, page, { stubs: { wakeLock: true } });
    await openToday(page);
    await beginWorkout(page);

    // Iniciar o treino NÃO pede a tela acesa.
    expect((await deviceLog(page)).wakeRequests).toBe(0);
    await page.getByRole('button', { name: 'Opções do treino' }).click();
    const dialog = page.getByRole('dialog', { name: 'Opções do treino' });
    const toggle = dialog.getByRole('switch', { name: /Manter a tela acesa/ });
    await expect(toggle).not.toBeChecked();
    await expect(dialog.getByText('Desligada: a tela apaga no tempo do aparelho.')).toBeVisible();
    await expect(
      dialog.getByText(/Com a tela bloqueada o descanso continua contando, mas não avisa/),
    ).toBeVisible();

    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect.poll(async () => (await deviceLog(page)).wakeActive).toBe(1);
    expect((await deviceLog(page)).wakeRequests).toBe(1);

    // O sistema solta o bloqueio ao esconder a aba; ao voltar, o app pede de novo.
    await page.evaluate(() => {
      const win = window as unknown as {
        __wake: { sentinels: { release(): Promise<void> }[] };
        __setVisibility(v: string): void;
      };
      void win.__wake.sentinels[0].release();
      win.__setVisibility('hidden');
      win.__setVisibility('visible');
    });
    await expect.poll(async () => (await deviceLog(page)).wakeRequests).toBe(2);
    await expect.poll(async () => (await deviceLog(page)).wakeActive).toBe(1);

    await toggle.uncheck();
    await expect.poll(async () => (await deviceLog(page)).wakeActive).toBe(0);
  });

  test('sem suporte à tela acesa, a folha diz isso e o interruptor fica desabilitado', async ({
    page,
    context,
  }) => {
    await launch(context, page, { stubs: { wakeLock: 'none' } });
    await openToday(page);
    await beginWorkout(page);

    await page.getByRole('button', { name: 'Opções do treino' }).click();
    const dialog = page.getByRole('dialog', { name: 'Opções do treino' });
    await expect(dialog.getByText('Este navegador não permite manter a tela acesa.')).toBeVisible();
    await expect(dialog.getByRole('switch', { name: /Manter a tela acesa/ })).toBeDisabled();
  });

  test('pular e substituir exercício: a troca vale só hoje, mantém o número da série e o exercício pulado volta pela lista', async ({
    page,
    context,
  }) => {
    await launch(context, page);
    await openToday(page);
    await beginWorkout(page);

    await menu(page, /Substituir exercício/);
    const chooser = page.getByRole('dialog', { name: 'Substituir exercício' });
    // Só o mesmo músculo, e fora o que já está na rotina de hoje.
    await expect(chooser.getByText('Supino inclinado com halteres')).toHaveCount(0);
    await chooser.getByRole('button', { name: /Supino reto com halteres/ }).click();

    await expect(
      page.getByRole('heading', { level: 2, name: 'Supino reto com halteres' }),
    ).toBeVisible();
    await expect(page.locator('.chips')).toContainText('trocado só hoje');
    await expect(page.getByText('exercício 1 de 3 · série 1 de 4')).toBeVisible();
    // Halteres: salto de 2 kg, e o exercício ainda não tem histórico (a carga começa vazia).
    await tap(page, 'Aumentar a carga');
    await expect(fieldValue(page, 'Carga')).toHaveValue('2');
    await concludeSet(page);
    await expect(page.locator('.sub')).toContainText('série 2 de 4');

    await menu(page, /Pular exercício/);
    await expect(
      page.getByRole('heading', { level: 2, name: 'Supino inclinado com halteres' }),
    ).toBeVisible();
    await expect(page.getByText('exercício 2 de 3 · série 1 de 3')).toBeVisible();

    await menu(page, /Exercícios do treino/);
    const plan = page.getByRole('dialog', { name: 'Exercícios do treino' });
    await expect(plan.getByText('pulado · toque para voltar a incluir')).toBeVisible();
    await plan.getByRole('button', { name: /Supino reto com halteres/ }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Supino reto com halteres' }),
    ).toBeVisible();
    await expect(page.locator('.sub')).toContainText('série 2 de 4');
  });

  test('recarregar SEM REDE no meio do treino mantém tudo; ao voltar a rede o servidor recebe cada série uma vez, em ordem', async ({
    page,
    context,
  }) => {
    const server = await launch(context, page);
    await openToday(page);
    await beginWorkout(page);

    // Duas séries com rede, a troca de exercício e então a rede cai.
    await concludeSet(page);
    await menu(page, /Substituir exercício/);
    await page
      .getByRole('dialog', { name: 'Substituir exercício' })
      .getByRole('button', { name: /Supino reto com halteres/ })
      .click();
    await tap(page, 'Aumentar a carga');
    await concludeSet(page);
    await expect.poll(() => server.writes('sets')).toBe(2);

    server.offline = true;
    await goOffline(page);
    await tap(page, 'Aumentar a carga');
    await concludeSet(page);
    await expect(page.locator('.sub')).toContainText('série 4 de 4');
    await expect(page.getByRole('heading', { name: 'Descanso' })).toBeVisible();
    // Só a série feita sem rede espera envio (as outras duas já subiram), e a tela diz isso.
    await expect(page.locator('.sending')).toContainText('1 série aguardando envio');
    expect(server.writes('sets')).toBe(2);

    // Recarrega ainda sem rede: sessão, série atual, troca e descanso continuam do aparelho.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: /Treino A/ })).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Supino reto com halteres' }),
    ).toBeVisible();
    await expect(page.locator('.chips')).toContainText('trocado só hoje');
    await expect(page.getByText('exercício 1 de 3 · série 4 de 4')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Descanso' })).toBeVisible();
    await expect(restTime(page)).toHaveText(/^\d:\d\d$/);
    await expect(fieldValue(page, 'Carga')).toHaveValue('4');
    await expect(page.locator('.sending')).toContainText('1 série aguardando envio');

    // Mais uma série, ainda sem rede, depois da recarga.
    await concludeSet(page);
    await expect(page.locator('.sending')).toContainText('2 séries aguardando envio');

    // A rede volta: o servidor recebe o treino e as 4 séries, uma vez cada, na ordem.
    server.offline = false;
    await goOnline(page);
    await expect.poll(() => server.writes('sets'), { timeout: 20_000 }).toBe(4);
    await expect(page.getByText(/sincronizado às \d{2}:\d{2}/)).toBeVisible();

    const puts = server.hits.filter((hit) => hit.method === 'PUT' && hit.outcome === 'executed');
    const sessions = puts.filter((hit) => /^sessions\/[^/]+$/.test(hit.path));
    const sets = puts.filter((hit) => /\/sets\//.test(hit.path));
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sets).toHaveLength(4);
    // Cada pedido executado tem a sua própria chave de idempotência.
    expect(new Set(puts.map((hit) => hit.key)).size).toBe(puts.length);
    // A ordem do envio é a do uso: a sessão antes das séries, e as séries na ordem em que foram feitas.
    expect(puts.indexOf(sessions[0])).toBeLessThan(puts.indexOf(sets[0]));
    const rows = server.rows('sets').filter((row) => typeof row['position'] === 'number');
    const byPosition = [...rows].sort(
      (a, b) => (a['position'] as number) - (b['position'] as number),
    );
    const sentIds = sets.map((hit) => hit.path.split('/').pop());
    expect(sentIds).toEqual(
      byPosition
        .filter((row) => row['sessionId'] === sessions[0].path.split('/')[1])
        .map((row) => row.id),
    );
    // A série feita com o substituto foi gravada com o exercício de fato feito.
    const done = byPosition.filter((row) => row['sessionId'] === sessions[0].path.split('/')[1]);
    expect(done.map((row) => String(row['exerciseId']).endsWith('03'))).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });

  test('treino inteiro SEM REDE, desde antes de iniciar: série editada, recarga no meio, fim do treino; ao voltar a rede o servidor recebe tudo uma vez, em ordem', async ({
    page,
    context,
  }) => {
    const server = await launch(context, page);
    // Com rede: catálogo, rotinas e histórico chegam ao aparelho. Daí a rede cai, ANTES de iniciar.
    await openToday(page);
    server.offline = true;
    await goOffline(page);
    await beginWorkout(page);

    await concludeSet(page); // série 1: 40 kg × 10
    await tap(page, 'Aumentar a carga');
    await concludeSet(page); // série 2: 42,5 kg × 10
    // Edita a série 1 (uma repetição a menos): vira um segundo pedido, mais novo, para a mesma série.
    await page.locator('.done .ui-row').first().click();
    const sheet = page.getByRole('dialog', { name: 'Editar série' });
    await sheet.getByRole('button', { name: 'Diminuir as repetições' }).click();
    await sheet.getByRole('button', { name: 'Salvar' }).click();
    await expect(sheet).toBeHidden();
    await concludeSet(page); // série 3

    // Recarrega no meio, ainda sem rede: tudo continua do aparelho.
    await page.reload();
    await expect(page.locator('.sub')).toContainText('série 4 de 4');
    await expect(page.locator('.sending')).toContainText('3 séries aguardando envio');
    await concludeSet(page); // série 4
    await menu(page, /Terminar treino/);

    await expect(page.getByRole('heading', { level: 1, name: 'Treino concluído' })).toBeVisible();
    await expect(page.getByText('Salvo no aparelho · 4 séries aguardam envio')).toBeVisible();
    expect(server.rows('sessions').filter((row) => row['deviceId'] !== OTHER_DEVICE)).toHaveLength(
      0,
    );

    // A rede volta: o servidor passa a ter o treino encerrado e as 4 séries, cada uma uma vez.
    server.offline = false;
    await goOnline(page);
    await expect(page.getByText(/tudo sincronizado/)).toBeVisible({ timeout: 20_000 });

    const mine = server.rows('sessions').filter((row) => row['deviceId'] !== OTHER_DEVICE);
    expect(mine).toHaveLength(1);
    expect(mine[0]['finishedAt']).not.toBeNull();
    const rows = server
      .rows('sets')
      .filter((row) => row['sessionId'] === mine[0].id)
      .sort((a, b) => (a['position'] as number) - (b['position'] as number));
    expect(rows).toHaveLength(4);
    // A série editada chegou com o valor editado, e as outras com os que foram gravados.
    expect(rows.map((row) => [row['weightKg'], row['reps']])).toEqual([
      [40, 9],
      [42.5, 10],
      [42.5, 10],
      [42.5, 10],
    ]);

    const puts = server.hits.filter((hit) => hit.method === 'PUT' && hit.outcome === 'executed');
    expect(new Set(puts.map((hit) => hit.key)).size).toBe(puts.length);
    // Na ordem do uso: a abertura do treino antes de qualquer série, e o fim do treino depois de todas.
    const isSession = (path: string) => /^sessions\/[^/]+$/.test(path);
    expect(isSession(puts[0].path)).toBe(true);
    expect(isSession(puts[puts.length - 1].path)).toBe(true);
    // Cada série foi enviada uma vez (a editada, duas: o pedido original e o da edição, com chaves diferentes).
    const perSet = new Map<string, number>();
    for (const hit of puts.filter((entry) => /\/sets\//.test(entry.path))) {
      const id = hit.path.split('/').pop()!;
      perSet.set(id, (perSet.get(id) ?? 0) + 1);
    }
    expect([...perSet.values()].sort()).toEqual([1, 1, 1, 2]);
  });

  test('o resumo mostra os números certos, os recordes com o valor de antes, e o recarregar segue nele', async ({
    page,
    context,
  }) => {
    await launch(context, page);
    await openToday(page);
    await beginWorkout(page);

    await tap(page, 'Aumentar a carga');
    await tap(page, 'Diminuir as repetições', 2);
    await concludeSet(page);
    await concludeSet(page);
    await page.clock.fastForward(25 * 60_000);
    await menu(page, /Terminar treino/);

    await expect(page.getByRole('heading', { level: 1, name: 'Treino concluído' })).toBeVisible();
    const stats = page.locator('.stat');
    // 42,5 kg × 8 duas vezes = 680 kg; duas séries de trabalho; dois recordes (carga máxima e 1RM).
    await expect(stats.nth(0)).toContainText('680 kg');
    await expect(stats.nth(1)).toContainText(/2[5-9] min/);
    await expect(stats.nth(2)).toContainText('2');
    await expect(stats.nth(3)).toContainText('2');
    const records = page.locator('.records .ui-row');
    await expect(records.nth(0)).toContainText('Supino reto com barra');
    await expect(records.nth(0)).toContainText('carga máxima 42,5 kg × 8 · antes 40 kg');
    await expect(records.nth(1)).toContainText('1RM estimado 53,8 kg · antes 53,3 kg');
    await expect(page.getByText(/Salvo no aparelho/)).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Treino concluído' })).toBeVisible();
    await expect(stats.nth(0)).toContainText('680 kg');

    // "Editar treino" abre as séries; uma se corrige e o resumo acompanha.
    await page.getByRole('button', { name: 'Editar treino' }).click();
    await page.locator('.sets .ui-row').first().click();
    const sheet = page.getByRole('dialog', { name: 'Editar série' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Diminuir as repetições' }).click();
    await sheet.getByRole('button', { name: 'Salvar' }).click();
    // 42,5 × 7 + 42,5 × 8 = 637,5 kg.
    await expect(stats.nth(0)).toContainText('637,5 kg');

    // "Concluir treino" volta a Hoje, e a sequência passou para a rotina B.
    await page.getByRole('button', { name: 'Concluir treino' }).click();
    await expect(page.getByRole('heading', { name: 'Treino B · Costas e bíceps' })).toBeVisible();
    await expect(page.locator('.week .stat').nth(0)).toHaveText(/^Treinoss*1$/);
  });

  test('apagar uma série pede confirmação e ela some do treino', async ({ page, context }) => {
    await launch(context, page);
    await openToday(page);
    await beginWorkout(page);
    await concludeSet(page);

    await page.locator('.done .ui-row').first().click();
    const sheet = page.getByRole('dialog', { name: 'Editar série' });
    await sheet.getByRole('button', { name: 'Apagar' }).click();
    await expect(
      sheet.getByText('Apagar esta série? Ela some do treino e dos recordes.'),
    ).toBeVisible();
    await sheet.getByRole('button', { name: 'Sim, apagar' }).click();
    await expect(page.locator('.done')).toHaveCount(0);
    await expect(page.locator('.sub')).toContainText('série 1 de 4');
  });

  test('treino livre: escolhe o exercício, registra com descanso padrão de 90 s e cancela o treino com confirmação', async ({
    page,
    context,
  }) => {
    await launch(context, page);
    await openToday(page);
    await page.getByRole('button', { name: 'Treino livre' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Treino livre' })).toBeVisible();
    await expect(page.getByText('Treino livre: escolha o primeiro exercício')).toBeVisible();

    await page.getByRole('button', { name: 'Escolher exercício' }).click();
    const chooser = page.getByRole('dialog', { name: 'Adicionar exercício' });
    await chooser.getByRole('button', { name: /Agachamento livre com barra/ }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Agachamento livre com barra' }),
    ).toBeVisible();

    await tap(page, 'Aumentar a carga', 4);
    await concludeSet(page);
    await expect(restTime(page)).toHaveText(/^(1:30|1:29|1:3\d|1:2\d)$/);
    await expect(page.locator('.rest .goal')).toHaveText('meta 1:30');

    await menu(page, /Cancelar treino/);
    await page.getByRole('button', { name: 'Sim, cancelar' }).click();
    await expect(page.getByRole('heading', { name: 'Esta semana' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Iniciar treino' })).toBeVisible();
  });
});
