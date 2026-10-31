import { Locator, Page } from '@playwright/test';
import { OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, screenshot, test } from '../fixtures';
import { mockAuditApi } from '../settings/audit-mock';
import { emitSse, installFakeEventSource, mockTvApi, sseUrls } from '../tv/tv-mock';
import { beginWorkout, installClock, openToday, stubDevice } from '../training/support/today-pages';
import { chooseMuscle, openTraining, startTraining } from '../training/support/training-pages';
import { SEED_ROUTINE_IDS } from '../training/support/training-seed';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

/**
 * Playwright não simula `env(safe-area-inset-bottom)`; o app lê a área segura de `--safe-inset` (styles.css), então o
 * teste põe nela o home indicator de um iPhone (34 px) e confere que tudo que fica embaixo o respeita.
 */
const HOME_INDICATOR = 34;

async function simulateInset(page: Page, px = HOME_INDICATOR): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.style.setProperty('--safe-inset', `${value}px`);
  }, px);
}

/** O elemento cabe inteiro acima da área segura e nada o cobre no ponto do meio. */
async function expectClearOfBottom(
  page: Page,
  target: Locator,
  inset = HOME_INDICATOR,
  // O aviso passageiro tem `pointer-events: none` (nada o cobre, mas elementFromPoint também não o vê).
  checkCover = true,
) {
  await target.scrollIntoViewIfNeeded();
  const viewport = page.viewportSize()!;
  const box = (await target.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - inset + 0.5);
  if (!checkCover) return;
  const covered = await target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return !top || !(node === top || node.contains(top) || top.contains(node));
  });
  expect(covered, 'algo cobre o controle').toBe(false);
}

test.describe('o que fica embaixo respeita a área segura', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('o botão Entrar fica acima da área segura ao rolar até o fim', async ({ context, page }) => {
    await mockIdentityApi(context);
    await page.goto('/entrar');
    await expect(page.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
    await simulateInset(page);
    await expectClearOfBottom(page, page.getByRole('button', { name: 'Entrar', exact: true }));
  });

  test('a folha de filtros mantém o rodapé de ações à vista', async ({ context, page }) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    await mockTvApi(context, identity);
    const audit = await mockAuditApi(context, identity);
    audit.items = [];
    await installFakeEventSource(page);
    await page.goto('/ajustes/auditoria');
    await page.getByRole('button', { name: /^Filtros/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Filtros' });
    await expect(sheet).toBeVisible();
    await simulateInset(page);
    await expectClearOfBottom(page, sheet.getByRole('button', { name: 'Cancelar' }));
    await expectClearOfBottom(page, sheet.getByRole('button', { name: 'Aplicar' }));
  });

  test('o treino ao vivo mantém o botão Concluir Série e a barra de baixo à vista', async ({
    context,
    page,
  }, info) => {
    await installClock(page);
    await stubDevice(page, { vibrate: true });
    await startTraining(context, page);
    await openToday(page, { history: false });
    await beginWorkout(page);
    await simulateInset(page);
    await expectClearOfBottom(page, page.getByRole('button', { name: 'Concluir Série' }));
    await screenshot(page, `test-results/bottom-safe-area/live-session-${info.project.name}.png`);
  });

  test('o conteúdo do treino ao vivo não soma a área segura duas vezes', async ({
    context,
    page,
  }) => {
    await installClock(page);
    await stubDevice(page, { vibrate: true });
    await startTraining(context, page);
    await openToday(page, { history: false });
    await beginWorkout(page);
    await simulateInset(page);
    const spacing = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>('app-training-page .content')!;
      const live = document.querySelector<HTMLElement>('app-live-session .live')!;
      return {
        shell: getComputedStyle(shell).paddingBottom,
        live: getComputedStyle(live).paddingBottom,
      };
    });
    expect(spacing.shell).toContain('px');
    expect(spacing.live).toBe('96px');
  });

  test('a barra de abas do Treino fica acima da área segura', async ({ context, page }, info) => {
    await startTraining(context, page);
    await openToday(page, { history: false });
    await simulateInset(page);
    const tabs = page.locator('app-tab-bar nav');
    await expect(tabs).toBeVisible();
    await expectClearOfBottom(page, tabs.getByRole('link').first());
    await screenshot(page, `test-results/bottom-safe-area/tab-bar-${info.project.name}.png`);
  });

  test('sem inset informado o piso do app instalado vale e os rodapés não colam na borda', async ({
    page,
    context,
  }) => {
    await startTraining(context, page);
    await openToday(page, { history: false });
    // `--safe-bottom` nunca é menor que o piso, e o piso vale mesmo com inset 0.
    const value = await page.evaluate(() => {
      const root = document.documentElement;
      root.style.setProperty('--safe-inset', '0px');
      root.style.setProperty('--safe-floor', '8px');
      const probe = document.createElement('div');
      probe.style.paddingBottom = 'var(--safe-bottom)';
      document.body.append(probe);
      const padding = getComputedStyle(probe).paddingBottom;
      probe.remove();
      return padding;
    });
    expect(value).toBe('8px');
  });
});

/**
 * A barra de ação fixa dos editores: a ação principal está inteira na tela mesmo sem rolar nada (é o que falha sem a
 * barra, já que `expectClearOfBottom` rola até o botão antes de medir) e começa desligada porque nada mudou.
 */
async function expectDockedAtRest(page: Page, save: Locator, inset = 0) {
  await expect(save).toBeDisabled();
  await page.evaluate(() => window.scrollTo(0, 0));
  const viewport = page.viewportSize()!;
  const box = (await save.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - inset + 0.5);
  const bar = page.locator('.ui-action-bar');
  await expect(bar).toBeVisible();
  const position = await bar.evaluate((node) => getComputedStyle(node).position);
  expect(position).toBe('fixed');
}

/** O último item do formulário rola até ficar acima da barra, sem nada por cima. */
async function expectLastItemClearOfBar(page: Page, last: Locator) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const bar = (await page.locator('.ui-action-bar').boundingBox())!;
  const box = (await last.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y + 0.5);
}

test.describe('os editores longos do Treino mantêm o Salvar fixo', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  });

  test('editor de rotina: o Salvar fica acima da área segura, liga com a mudança e o fim do formulário rola acima dele', async ({
    context,
    page,
  }, info) => {
    await startTraining(context, page);
    await openTraining(page, `/treino/rotinas/${SEED_ROUTINE_IDS.a}`);
    const save = page.getByRole('button', { name: 'Salvar Rotina' });
    await expect(page.getByRole('heading', { name: 'Editar Rotina' })).toBeVisible();
    await simulateInset(page);
    await expectDockedAtRest(page, save, HOME_INDICATOR);

    await page.getByLabel('Nome da rotina').fill('Treino A · Peito');
    await expect(save).toBeEnabled();
    await screenshot(page, `test-results/bottom-safe-area/routine-editor-${info.project.name}.png`);

    await expectLastItemClearOfBar(page, page.getByRole('button', { name: 'Apagar Rotina' }));
  });

  test('formulário de exercício: o Salvar liga só com nome e músculo', async ({
    context,
    page,
  }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/exercicios/novo');
    const save = page.getByRole('button', { name: 'Salvar Exercício' });
    await expectDockedAtRest(page, save);
    await page.getByLabel('Nome').fill('Remada articulada');
    await expect(page.getByText('Escolha o músculo principal.')).toBeVisible();
    await expect(save).toBeDisabled();
    await chooseMuscle(page, 'Meio das costas');
    await expect(save).toBeEnabled();
  });

  test('avaliação física: o Salvar fica fixo e liga com a mudança', async ({ context, page }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/corpo/avaliacoes/nova');
    const save = page.getByRole('button', { name: 'Salvar Avaliação' });
    await expectDockedAtRest(page, save);
    await page.getByLabel('Origem / clínica / sistema').fill('Clínica de teste');
    await expect(save).toBeEnabled();
  });
});

/**
 * Teclado virtual simulado: o Playwright não abre teclado, então a página ganha um `visualViewport` falso, cuja altura
 * é a da janela menos o que o teclado cobre. `cover(px)` muda a altura e dispara o `resize` que o app escuta.
 */
const KEYBOARD = 300;

async function installFakeKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let covered = 0;
    const target = new EventTarget();
    Object.defineProperties(target, {
      height: { get: () => window.innerHeight - covered },
      offsetTop: { value: 0 },
    });
    Object.defineProperty(window, 'visualViewport', { value: target, configurable: true });
    (window as unknown as Record<string, unknown>)['__cover'] = (px: number) => {
      covered = px;
      target.dispatchEvent(new Event('resize'));
    };
  });
}

async function cover(page: Page, px = KEYBOARD): Promise<void> {
  await page.evaluate(
    (value) => (window as never as { __cover(px: number): void }).__cover(value),
    px,
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--kb-inset'),
      ),
    )
    .toBe(`${px}px`);
}

test.describe('com o teclado aberto o que fica embaixo sobe com ele', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installFakeKeyboard(page);
  });

  test('o dock fixo do treino ao vivo fica acima do teclado', async ({ context, page }) => {
    await installClock(page);
    await stubDevice(page, { vibrate: true });
    await startTraining(context, page);
    await openToday(page, { history: false });
    await beginWorkout(page);
    await cover(page);
    await expectClearOfBottom(page, page.getByRole('button', { name: 'Concluir Série' }), KEYBOARD);
  });

  test('a folha mantém o rodapé sticky acima do teclado e cabe na parte visível', async ({
    context,
    page,
  }) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    await mockTvApi(context, identity);
    const audit = await mockAuditApi(context, identity);
    audit.items = [];
    await installFakeEventSource(page);
    await page.goto('/ajustes/auditoria');
    await page.getByRole('button', { name: /^Filtros/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Filtros' });
    await expect(sheet).toBeVisible();
    await cover(page);
    await expectClearOfBottom(page, sheet.getByRole('button', { name: 'Cancelar' }), KEYBOARD);
    await expectClearOfBottom(page, sheet.getByRole('button', { name: 'Aplicar' }), KEYBOARD);
    const top = (await sheet.boundingBox())!.y;
    expect(top).toBeGreaterThanOrEqual(0);
  });

  test('a barra de abas fica acima do teclado', async ({ context, page }) => {
    await startTraining(context, page);
    await openToday(page, { history: false });
    await cover(page);
    await expectClearOfBottom(
      page,
      page.locator('app-tab-bar nav').getByRole('link').first(),
      KEYBOARD,
    );
  });

  test('o Salvar do editor de rotina sobe com o teclado e o aviso de saída fica ao lado dele', async ({
    context,
    page,
  }) => {
    await startTraining(context, page);
    await openTraining(page, `/treino/rotinas/${SEED_ROUTINE_IDS.a}`);
    const name = page.getByLabel('Nome da rotina');
    await name.fill('Treino A · Peito');
    const save = page.getByRole('button', { name: 'Salvar Rotina' });
    await expect(save).toBeEnabled();
    await cover(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectClearOfBottom(page, save, KEYBOARD);
    const viewport = page.viewportSize()!;
    const box = (await save.boundingBox())!;
    // Sem rolar nada: o botão já está na parte que o teclado deixa à vista.
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - KEYBOARD + 0.5);

    // Sair com mudança abre o aviso dentro da barra, junto do Salvar (e não numa parte do formulário fora de vista).
    await page.getByRole('button', { name: 'Cancelar' }).click();
    const warning = page.locator('.ui-action-bar').getByText('Sair sem salvar?');
    await expect(warning).toBeVisible();
    const warningBox = (await warning.boundingBox())!;
    expect(warningBox.y).toBeGreaterThanOrEqual(0);
    expect(warningBox.y + warningBox.height).toBeLessThanOrEqual(viewport.height - KEYBOARD + 0.5);
  });

  test('o Salvar do formulário de exercício fica acima do teclado', async ({ context, page }) => {
    await startTraining(context, page);
    await openTraining(page, '/treino/exercicios/novo');
    await page.getByLabel('Nome').fill('Remada articulada');
    await chooseMuscle(page, 'Meio das costas');
    const save = page.getByRole('button', { name: 'Salvar Exercício' });
    await expect(save).toBeEnabled();
    await cover(page);
    await expectClearOfBottom(page, save, KEYBOARD);
  });

  test('o aviso passageiro da TV fica acima do teclado', async ({ context, page }) => {
    const identity = await mockIdentityApi(context);
    const tv = await mockTvApi(context, identity);
    await installFakeEventSource(page);
    await page.goto('/entrar');
    await page.getByLabel('E-mail').fill(OWNER.email);
    await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/tv');
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await emitSse(page, 'tv.state', tv.state);
    await emitSse(page, 'tv.shortcuts', tv.shortcuts);
    await cover(page);
    await page.getByRole('button', { name: 'Desligar a TV' }).click();
    await page
      .getByRole('dialog', { name: 'Desligar a TV?' })
      .getByRole('button', { name: 'Desligar', exact: true })
      .click();
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible();
    await expectClearOfBottom(page, toast, KEYBOARD, false);
  });
});
