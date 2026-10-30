import { BrowserContext, Page } from '@playwright/test';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { seedBenchHistory } from './support/today-seed';
import {
  openSessionMenu,
  beginWorkout,
  concludeSet,
  fieldValue,
  installClock,
  openToday,
  stubDevice,
  tap,
} from './support/today-pages';
import { startTraining } from './support/training-pages';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

async function launch(context: BrowserContext, page: Page): Promise<void> {
  await installClock(page);
  await stubDevice(page, { vibrate: true });
  const server = await startTraining(context, page);
  seedBenchHistory(server);
}

/** Caixa da tela (em pixels da janela) de um elemento; `null` quando ele não está na página. */
async function box(page: Page, selector: string) {
  return page.locator(selector).first().boundingBox();
}

test.describe('primeira parte do exercício', () => {
  test.beforeEach(async ({ page }) => {
    // Sem movimento: a medida da ilustração e do cartão não depende de transição em curso.
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('o topo é o do controle da TV: um voltar só, "Treino" e o interruptor da tela acesa', async ({
    page,
    context,
  }) => {
    await launch(context, page);
    await openToday(page);
    await beginWorkout(page);

    // Um topo só, o da casca: uma seta, "Treino" no centro e os três pontos; a tela não tem cabeçalho nem voltar próprios.
    await expect(page.locator('app-page-top-bar h1')).toHaveText('Treino');
    await expect(page.locator('app-page-top-bar .back')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Voltar/ })).toHaveCount(1);
    await expect(page.getByRole('link', { name: /^Voltar/ })).toHaveCount(0);
    await expect(page.locator('app-live-session header')).toHaveCount(0);
    await expect(
      page.locator('app-page-top-bar').getByRole('button', { name: 'Mais opções' }),
    ).toHaveCount(1);
    await expect(page.getByRole('switch', { name: 'Manter a Tela Acesa' })).toBeVisible();

    // O título fica no centro da tela, com ou sem o botão a mais de um dos lados.
    const title = (await box(page, 'app-page-top-bar h1'))!;
    const viewport = page.viewportSize()!;
    expect(Math.abs(title.x + title.width / 2 - viewport.width / 2)).toBeLessThan(2);
  });

  test('o nome é o título de largura total, com a rotina e a posição na lista abaixo', async ({
    page,
    context,
  }) => {
    await launch(context, page);
    await openToday(page);
    await beginWorkout(page);

    const name = page.getByRole('heading', { level: 2, name: 'Supino reto com barra' });
    await expect(name).toBeVisible();
    await expect(page.locator('.sub .routine')).toContainText('Treino A');
    await expect(page.locator('.sub .position')).toHaveText('1 de 3 exercícios');
    await expect(page.locator('.set-title')).toHaveText('Série 1 de 4');
    await expect(page.locator('.focus .goal')).toHaveText('Meta 6–10 reps');
    // O nome cabe numa linha (sem quebrar) em qualquer das duas larguras.
    const lines = await name.evaluate((node) => {
      const style = getComputedStyle(node);
      return Math.round(node.getBoundingClientRect().height / parseFloat(style.lineHeight));
    });
    expect(lines).toBe(1);
  });

  test('a ilustração toma o espaço que sobra, e o nome, a série, os campos e o botão cabem sem rolar', async ({
    page,
    context,
  }) => {
    await launch(context, page);
    await openToday(page);
    await beginWorkout(page);
    await expect(page.locator('.art app-exercise-illustration .frame').first()).toBeVisible();

    const viewport = page.viewportSize()!;
    const art = (await box(page, '.art'))!;
    const name = (await box(page, '.top .name'))!;
    const fields = (await box(page, '.setcard'))!;
    const dock = (await box(page, '.dock'))!;

    // Bem maior que a miniatura de 136 px de antes, mesmo com o topo da casca e a fileira do interruptor acima dela.
    expect(art.height).toBeGreaterThan(180);
    // Tudo o que importa está na primeira tela, acima do botão fixo de baixo.
    expect(name.y).toBeGreaterThanOrEqual(0);
    expect(fields.y + fields.height).toBeLessThanOrEqual(dock.y + 1);
    expect(dock.y + dock.height).toBeLessThanOrEqual(viewport.height + 1);
    // E o desenho e os campos são do mesmo tamanho de largura que a coluna (sem miniatura espremida ao lado do nome).
    const image = (await box(page, '.art app-exercise-illustration'))!;
    expect(image.width).toBeGreaterThan(180);
    await expectNoHorizontalScroll(page);
  });

  test('os botões − e + e o Concluir Série têm 56 px ou mais, até no instante depois do toque, e a ilustração segue o maior elemento da primeira tela', async ({
    page,
    context,
  }) => {
    await launch(context, page);
    await openToday(page);
    await beginWorkout(page);

    // O tamanho de layout (sem transformação) e o da caixa visível logo depois de tocar, sem esperar a transição.
    for (const name of [
      'Aumentar a carga',
      'Diminuir a carga',
      'Aumentar as repetições',
      'Diminuir as repetições',
    ]) {
      const button = page.getByRole('button', { name, exact: true });
      await button.click();
      const visible = (await button.boundingBox())!;
      expect(Math.min(visible.width, visible.height), name).toBeGreaterThanOrEqual(56);
      const layout = await button.evaluate((node) => [
        (node as HTMLElement).offsetWidth,
        (node as HTMLElement).offsetHeight,
      ]);
      expect(Math.min(...layout), name).toBeGreaterThanOrEqual(56);
    }
    const go = (await page.getByRole('button', { name: 'Concluir Série' }).boundingBox())!;
    expect(Math.min(go.width, go.height)).toBeGreaterThanOrEqual(56);

    // Na primeira dobra do iPhone 12 a ilustração é o maior elemento (por área).
    const area = async (selector: string) => {
      const found = (await box(page, selector))!;
      return found.width * found.height;
    };
    const art = await area('.art');
    for (const other of ['.setcard', '.top', '.focus', '.dock']) {
      expect(art, other).toBeGreaterThan(await area(other));
    }
  });

  test('esforço, última vez, anotação e aquecimento ficam recolhidos ou abaixo da primeira tela', async ({
    page,
    context,
  }) => {
    await launch(context, page);
    await openToday(page);
    await beginWorkout(page);

    // Recolhidos: só os botões.
    const rpe = page.getByRole('button', { name: /Esforço \(RPE\)/ });
    const hint = page.getByRole('button', { name: 'Última Vez e Sugestão' });
    await expect(rpe).toHaveAttribute('aria-expanded', 'false');
    await expect(hint).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.rpe')).toBeHidden();
    await expect(page.locator('app-focus-hint .panel')).toBeHidden();
    await expect(page.getByText('42,5 kg × 6–8')).toBeHidden();

    // Abaixo do cartão da série (a primeira tela é do registro).
    const fields = (await box(page, '.setcard'))!;
    expect((await rpe.boundingBox())!.y).toBeGreaterThan(fields.y + fields.height - 1);
    expect((await hint.boundingBox())!.y).toBeGreaterThan(fields.y + fields.height - 1);

    await rpe.click();
    await expect(rpe).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.rpe')).toBeVisible();
    await expect(page.locator('.rpe-button')).toHaveCount(5);
    await page.getByRole('button', { name: '8', exact: true }).click();
    await expect(page.getByRole('button', { name: '8', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await hint.click();
    await expect(page.getByText('42,5 kg × 6–8')).toBeVisible();
  });

  test('o esforço e a referência abertos numa série voltam recolhidos na série seguinte', async ({
    page,
    context,
  }) => {
    await launch(context, page);
    await openToday(page);
    await beginWorkout(page);

    await page.getByRole('button', { name: /Esforço \(RPE\)/ }).click();
    await page.getByRole('button', { name: '8', exact: true }).click();
    await page.getByRole('button', { name: 'Anotação' }).click();
    await page.getByLabel('Anotação da série').fill('banco na altura 3');
    await page.getByRole('button', { name: 'Última Vez e Sugestão' }).click();
    await page.getByRole('button', { name: 'Por que esta sugestão?' }).click();
    await concludeSet(page);

    // Série 2: o esforço e a anotação recomeçam fechados e vazios; a referência segue como a pessoa deixou.
    await expect(page.locator('.set-title')).toHaveText('Série 2 de 4');
    await expect(page.getByRole('button', { name: /Esforço \(RPE\)/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(page.locator('.rpe')).toBeHidden();
    await expect(page.getByLabel('Anotação da série')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Anotação' })).toBeVisible();
    await page.getByRole('button', { name: /Esforço \(RPE\)/ }).click();
    await expect(page.locator('.rpe-button[aria-pressed="true"]')).toHaveCount(0);
  });

  test('no descanso com recorde de carga e de 1RM, todos os atalhos ficam na tela sem rolar', async ({
    page,
    context,
  }) => {
    await launch(context, page);
    await openToday(page);
    await beginWorkout(page);
    await tap(page, 'Aumentar a carga');
    await tap(page, 'Diminuir as repetições', 2);
    await concludeSet(page);

    const rest = page.locator('.rest');
    await expect(rest).toContainText('carga máxima 42,5 kg');
    await expect(rest).toContainText('1RM estimado');
    await expect.poll(async () => (await box(page, '.art'))?.height ?? 0).toBeLessThan(2);
    const viewport = page.viewportSize()!;
    for (const name of ['Pular Descanso', '+15 s', 'Encerrar Exercício', 'Encerrar Treino']) {
      const target = (await rest.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(target.y, name).toBeGreaterThanOrEqual(0);
      expect(target.y + target.height, name).toBeLessThanOrEqual(viewport.height);
    }
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('a tela acesa liga e desliga no topo, sem ir ao menu', async ({ page, context }) => {
    await launch(context, page);
    await openToday(page);
    await beginWorkout(page);

    const toggle = page.getByRole('switch', { name: 'Manter a Tela Acesa' });
    await expect(toggle).not.toBeChecked();
    await openSessionMenu(page);
    const menu = page.getByRole('dialog', { name: 'Opções do Treino' });
    await expect(menu.getByRole('switch')).toHaveCount(0);
    await expect(menu.getByText(/iOS 18/)).toHaveCount(0);
  });

  test('no descanso a ilustração recolhe, o recorde aparece uma vez só e o cartão traz o relógio', async ({
    page,
    context,
  }) => {
    await launch(context, page);
    await openToday(page);
    await beginWorkout(page);

    await tap(page, 'Aumentar a carga');
    await tap(page, 'Diminuir as repetições', 2);
    await concludeSet(page);

    await expect(page.locator('.rest .time')).toBeVisible();
    await expect.poll(async () => (await box(page, '.art'))?.height ?? 0).toBeLessThan(2);
    // O recorde fica no cartão do descanso; o aviso próprio não repete a informação na mesma tela.
    await expect(page.locator('.rest')).toContainText('carga máxima 42,5 kg');
    await expect(page.getByRole('status').filter({ hasText: 'Recorde!' })).toHaveCount(0);
    // A série seguinte já está preparada logo abaixo, e a tela cabe sem rolar na largura.
    await expect(page.locator('.set-title')).toHaveText('Série 2 de 4');
    await expect(fieldValue(page, 'Carga')).toHaveValue('42,5');
    await expectNoHorizontalScroll(page);

    // Ao pular o descanso, a ilustração volta a ocupar o espaço.
    await page.getByRole('button', { name: 'Pular Descanso', exact: true }).click();
    await expect(page.locator('.rest')).toHaveCount(0);
    await expect.poll(async () => (await box(page, '.art'))?.height ?? 0).toBeGreaterThan(180);
  });
});
