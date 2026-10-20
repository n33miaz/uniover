import { writeFileSync } from 'node:fs';
import { Locator, Page } from '@playwright/test';
import { IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { TvMock, emitSse, installFakeEventSource, mockTvApi, sseUrls } from './tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const PREFS_KEY = 'uniover.tv.prefs.v1';
/** O apelido mais longo que o cabeçalho comporta (20 letras), um nome de verdade e com espaços. */
const LONG_NAME = 'Casa da praia - sala';
/** Nomes de vários tamanhos: todos têm de aparecer inteiros, no meio da tela, sem tocar nos botões. */
const NAMES = [
  'TV',
  'Sala 1',
  'Quarto 12',
  'TV da sala',
  'Sala de estar',
  'TV do Neemias',
  'Quarto de hóspedes',
  'TV da sala de estar',
  'Televisaodasalaestar',
  LONG_NAME,
];

let identity: IdentityMock;
let tv: TvMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  tv = await mockTvApi(context, identity);
  await installFakeEventSource(page);
});

async function signIn(page: Page) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Entra e abre /tv; `prefs` já deixa escolhas guardadas, como se a pessoa tivesse personalizado antes. */
async function openTv(page: Page, prefs?: Record<string, unknown>) {
  await signIn(page);
  if (prefs) {
    await page.evaluate(
      ([key, value]) => localStorage.setItem(key as string, JSON.stringify(value)),
      [PREFS_KEY, prefs] as const,
    );
  }
  await page.goto('/tv');
  await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
  await emitSse(page, 'tv.state', tv.state);
  await emitSse(page, 'tv.shortcuts', tv.shortcuts);
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeVisible();
  await settle(page);
}

/** Troca as escolhas guardadas e recarrega a tela, sem entrar de novo (a sessão já está aberta). */
async function reloadWith(page: Page, prefs: Record<string, unknown>) {
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key as string, JSON.stringify(value)),
    [PREFS_KEY, prefs] as const,
  );
  await page.reload();
  await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
  await emitSse(page, 'tv.state', tv.state);
  await emitSse(page, 'tv.shortcuts', tv.shortcuts);
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeVisible();
  await settle(page);
}

const header = (page: Page) => page.locator('header.head');
const backLink = (page: Page) => header(page).getByRole('link', { name: 'Voltar ao Início' });
const appsButton = (page: Page) => header(page).getByRole('button', { name: 'Apps da TV' });
const powerButton = (page: Page) => header(page).getByRole('button', { name: 'Desligar a TV' });
const titleButton = (page: Page) => header(page).getByRole('button', { name: /, personalizar$/ });
const statusDot = (page: Page) =>
  header(page).getByRole('button', { name: /^Estado do controle:/ });
const customizeDialog = (page: Page) => page.getByRole('dialog', { name: 'Personalizar' });
const powerDialog = (page: Page) => page.getByRole('dialog', { name: 'Desligar a TV?' });
const keyButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found, 'elemento sem caixa na tela').not.toBeNull();
  return found!;
}

async function expectNoVerticalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  expect(overflow, 'a tela não pode rolar na vertical').toBeLessThanOrEqual(0);
}

/** O centro do nome (o <h1>) tem de coincidir com o centro da TELA, e o ponto de estado não pode tocar nos botões. */
async function expectTitleCentered(page: Page) {
  const viewport = await page.evaluate(() => window.innerWidth);
  const title = await box(header(page).locator('h1'));
  expect(Math.abs(title.x + title.width / 2 - viewport / 2), 'centro do nome').toBeLessThanOrEqual(
    2,
  );

  const dot = await box(statusDot(page));
  expect(dot.x, 'o ponto fica depois do começo do nome').toBeGreaterThanOrEqual(title.x);
  expect(dot.x + dot.width, 'o ponto cabe na tela').toBeLessThanOrEqual(viewport);
  const apps = await box(appsButton(page));
  expect(dot.x + dot.width, 'o ponto não encosta no botão Apps').toBeLessThanOrEqual(apps.x + 0.5);
  const back = await box(backLink(page));
  expect(title.x, 'o nome não encosta no voltar').toBeGreaterThanOrEqual(back.x + back.width);
  await expect(statusDot(page)).toBeVisible();
}

/** O painelzinho do ponto tem de ficar por cima do controle (ali o toque cai nele, e não no anel que vem depois). */
async function expectStatusPanelOnTop(page: Page) {
  const panel = page.locator('app-status-indicator .panel');
  await expect(panel).toBeVisible();
  const rect = await box(panel);
  const onTop = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest('app-status-indicator .panel'),
    [rect.x + rect.width / 2, rect.y + rect.height / 2] as const,
  );
  expect(onTop, 'o painelzinho fica por cima do anel e dos botões').toBe(true);
}

/**
 * O nome aparece inteiro: no máximo duas linhas, sem reticências (o texto não passa da caixa) e dentro dos 44 px do
 * cabeçalho. As linhas contam-se pelas caixas do texto, e não pela altura, que o corte esconderia.
 */
async function expectTitleWhole(page: Page) {
  const found = await header(page)
    .locator('.title-text')
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      return {
        lines,
        overflowsWidth: el.scrollWidth > el.clientWidth + 1,
        fontSize: parseFloat(getComputedStyle(el).fontSize),
        textWidth: el.clientWidth,
        headingHeight: el.closest('h1')!.getBoundingClientRect().height,
      };
    });
  expect(found.lines, 'o nome cabe em até duas linhas, sem reticências').toBeLessThanOrEqual(2);
  expect(found.overflowsWidth, 'o nome não passa da largura da coluna').toBe(false);
  expect(found.headingHeight, 'o nome cabe nos 44 px do cabeçalho').toBeLessThanOrEqual(44.5);
  return found;
}

async function choose(page: Page, label: string) {
  await customizeDialog(page).getByRole('button', { name: label, exact: true }).click();
}

async function closeCustomize(page: Page) {
  await customizeDialog(page).getByRole('button', { name: 'Concluir' }).click();
  await expect(customizeDialog(page)).toHaveCount(0);
}

test.describe('cabeçalho: voltar, nome, Apps e energia', () => {
  test('voltar é uma seta num círculo de 44 px, com o mesmo visual do botão de energia', async ({
    page,
  }, info) => {
    await openTv(page);
    const back = backLink(page);
    await expect(back).toHaveAttribute('href', '/');
    await expect(back).toHaveText('');

    // O desenho é exatamente o que a casca do app usa, para os dois ficarem iguais.
    const svg = await back.locator('svg').evaluate((el) => ({
      attributes: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
      paths: [...el.querySelectorAll('path')].map((p) => p.getAttribute('d')),
    }));
    expect(svg.attributes).toMatchObject({
      viewBox: '0 0 24 24',
      width: '22',
      height: '22',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2.2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    });
    expect(svg.paths).toEqual(['M19 12H5', 'M11 18l-6-6 6-6']);

    for (const target of [back, appsButton(page), powerButton(page)]) {
      const size = await box(target);
      expect(size.width).toBeCloseTo(44, 0);
      expect(size.height).toBeCloseTo(44, 0);
    }
    const style = (target: Locator) =>
      target.evaluate((el) => {
        const css = getComputedStyle(el);
        return {
          border: css.borderTopColor,
          width: css.borderTopWidth,
          background: css.backgroundColor,
          radius: css.borderTopLeftRadius,
        };
      });
    expect(await style(back)).toEqual(await style(powerButton(page)));
    expect(await style(appsButton(page))).toEqual(await style(powerButton(page)));

    await screenshot(page, `test-results/tv-header-default-${info.project.name}.png`);
  });

  test('o nome é o da TV, no meio da tela, com o ponto de estado ao lado', async ({ page }) => {
    await openTv(page);
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('TV');
    await expectTitleCentered(page);
    // O ponto fica fora do <h1>: o nome do botão não vira parte do nome do título.
    await expect(header(page).locator('h1 app-status-indicator')).toHaveCount(0);
  });

  test('o apelido aparece no lugar de "TV" e o nome continua no meio da tela', async ({ page }) => {
    await openTv(page, { name: 'Sala' });
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('Sala');
    await expect(titleButton(page)).toHaveAccessibleName('Sala, personalizar');
    await expectTitleCentered(page);
  });

  test('nomes de 1 a 20 letras aparecem inteiros, em até duas linhas, no meio da tela', async ({
    page,
  }, info) => {
    await openTv(page);
    const seen: unknown[] = [];
    for (const name of NAMES) {
      await reloadWith(page, { name });
      await expect(header(page).getByRole('heading', { level: 1 })).toHaveText(name);
      await expect(titleButton(page)).toHaveAccessibleName(`${name}, personalizar`);
      await expectTitleCentered(page);
      await expectNoHorizontalScroll(page);
      seen.push({ name, ...(await expectTitleWhole(page)) });
    }
    // Fica em test-results para quem for ler os números (o relatório da rodada cita estes).
    writeFileSync(
      `test-results/tv-header-title-${info.project.name}.json`,
      JSON.stringify(seen, null, 2),
    );
  });

  test('o nome mais longo: inteiro em duas linhas, o ponto empurrado para fora e o painelzinho dentro da tela', async ({
    page,
  }, info) => {
    await openTv(page, { name: LONG_NAME });
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText(LONG_NAME);
    await expectTitleCentered(page);
    await expectTitleWhole(page);
    await expectNoHorizontalScroll(page);
    await screenshot(page, `test-results/tv-header-long-${info.project.name}.png`);

    // O painelzinho do ponto, aberto com o ponto longe do meio, não passa da tela.
    await statusDot(page).click();
    const panel = page.locator('app-status-indicator .panel');
    await expect(panel).toBeVisible();
    const viewport = await page.evaluate(() => window.innerWidth);
    const rect = await box(panel);
    expect(rect.x, 'borda esquerda do painelzinho').toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width, 'borda direita do painelzinho').toBeLessThanOrEqual(viewport);
    await expectNoHorizontalScroll(page);
    await expectStatusPanelOnTop(page);
    await screenshot(page, `test-results/tv-header-long-status-${info.project.name}.png`);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });

  test('o painelzinho do ponto cabe na tela também com o nome padrão', async ({ page }) => {
    await openTv(page);
    await statusDot(page).click();
    const panel = page.locator('app-status-indicator .panel');
    await expect(panel).toBeVisible();
    const viewport = await page.evaluate(() => window.innerWidth);
    const rect = await box(panel);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(viewport);
    await expectNoHorizontalScroll(page);
    await expectStatusPanelOnTop(page);
  });

  test('o botão Apps do cabeçalho abre o painel mesmo sem agente, e o foco volta a ele', async ({
    page,
  }) => {
    await openTv(page);
    await expect(appsButton(page)).toHaveAttribute('aria-haspopup', 'dialog');
    // Sem agente os botões da TV apagam, mas o painel lê a lista guardada.
    await emitSse(page, 'tv.state', {
      ...tv.state,
      agentOnline: false,
      connection: 'disconnected',
    });
    await expect(powerButton(page)).toBeDisabled();
    await expect(appsButton(page)).toBeEnabled();

    await appsButton(page).click();
    const dialog = page.getByRole('dialog', { name: 'Apps da TV' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(appsButton(page)).toBeFocused();
  });

  test('alvos de toque de 44 px ou mais, sem rolagem horizontal, com e sem a folha aberta', async ({
    page,
  }) => {
    await openTv(page);
    expect(await smallTargets(page)).toEqual([]);
    await expectNoHorizontalScroll(page);

    await titleButton(page).click();
    await expect(customizeDialog(page)).toBeVisible();
    await settle(page);
    expect(await smallTargets(page)).toEqual([]);
    await expectNoHorizontalScroll(page);
  });

  test('passa no axe, nos dois temas, com o cabeçalho e as folhas abertas', async ({
    page,
  }, info) => {
    await openTv(page, { name: LONG_NAME });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectNoA11yViolations(page);

      await titleButton(page).click();
      await expect(customizeDialog(page)).toBeVisible();
      await settle(page);
      await expectNoA11yViolations(page);
      await screenshot(page, `test-results/tv-header-customize-${scheme}-${info.project.name}.png`);
      await closeCustomize(page);

      await powerButton(page).click();
      await expect(powerDialog(page)).toBeVisible();
      await settle(page);
      await expectNoA11yViolations(page);
      await screenshot(page, `test-results/tv-header-power-${scheme}-${info.project.name}.png`);
      await powerDialog(page).getByRole('button', { name: 'Cancelar' }).click();
      await expect(powerDialog(page)).toHaveCount(0);
    }
  });
});

test.describe('Personalizar', () => {
  test('tocar no título abre a folha; o apelido vale na hora, fica depois de recarregar e volta ao padrão', async ({
    page,
  }) => {
    await openTv(page);
    await titleButton(page).click();
    const sheet = customizeDialog(page);
    await expect(sheet).toBeVisible();
    // O foco não cai no campo: o teclado do aparelho não pode abrir sozinho.
    await expect(sheet.getByRole('button', { name: 'Concluir' })).toBeFocused();

    // Digitado letra a letra: o espaço no meio do nome não pode sumir.
    const field = sheet.getByLabel('Nome da TV');
    await field.click();
    await field.pressSequentially('Sala de estar');
    await expect(field).toHaveValue('Sala de estar');
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('Sala de estar');
    await expectTitleCentered(page);

    await closeCustomize(page);
    await expect(titleButton(page)).toBeFocused();

    await page.reload();
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await emitSse(page, 'tv.state', tv.state);
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('Sala de estar');

    await titleButton(page).click();
    await expect(sheet.getByLabel('Nome da TV')).toHaveValue('Sala de estar');
    await sheet.getByRole('button', { name: 'Restaurar padrão' }).click();
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('TV');
    await expect(sheet.getByLabel('Nome da TV')).toHaveValue('');
    await expect(sheet.getByRole('button', { name: 'Restaurar padrão' })).toBeDisabled();
    await closeCustomize(page);

    await page.reload();
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await emitSse(page, 'tv.state', tv.state);
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('TV');
  });

  test('limita o apelido a 20 caracteres e aparar o vazio volta a "TV"', async ({ page }) => {
    await openTv(page);
    await titleButton(page).click();
    const field = customizeDialog(page).getByLabel('Nome da TV');
    await field.fill('x'.repeat(40));
    await expect(field).toHaveValue('x'.repeat(20));
    await field.fill('   ');
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('TV');
  });

  test('desligar os grupos de teclas esconde as teclas de mídia e o canal, e a escolha fica', async ({
    page,
  }) => {
    await openTv(page);
    await expect(keyButton(page, 'Mudo')).toBeVisible();
    await expect(keyButton(page, 'Próximo canal')).toBeVisible();

    await titleButton(page).click();
    const sheet = customizeDialog(page);
    await sheet.getByRole('switch', { name: 'Teclas de mídia' }).uncheck();
    await sheet.getByRole('switch', { name: 'Canal' }).uncheck();
    await closeCustomize(page);
    for (const name of ['Mudo', 'Anterior', 'Reproduzir ou pausar', 'Próxima', 'Próximo canal']) {
      await expect(keyButton(page, name)).toHaveCount(0);
    }
    await expect(keyButton(page, 'Teclado')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Volume' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Canal' })).toHaveCount(0);
    await expectNoVerticalScroll(page);
    await expectNoHorizontalScroll(page);
    expect(await smallTargets(page)).toEqual([]);

    await page.reload();
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await emitSse(page, 'tv.state', tv.state);
    await expect(keyButton(page, 'Voltar')).toBeVisible();
    await expect(keyButton(page, 'Mudo')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Canal' })).toHaveCount(0);
  });

  test('a página inicial do palco escolhida vale ao abrir, e "última usada" lembra a da aba', async ({
    page,
  }) => {
    const current = () =>
      page.locator('app-page-dots .dot[aria-current="true"]').getAttribute('aria-label');

    await openTv(page, { startPage: 'touchpad' });
    await expect(page.locator('app-page-dots .dot[aria-current="true"]')).toHaveAttribute(
      'aria-label',
      'Página 3 de 3',
    );

    await page.getByRole('button', { name: 'Página 2 de 3' }).click();
    await expect.poll(current).toBe('Página 2 de 3');
    await page.reload();
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    // Escolhida a página fixa, a que a aba lembra não manda.
    await expect.poll(current).toBe('Página 3 de 3');

    await titleButton(page).click();
    await choose(page, 'Última usada');
    await closeCustomize(page);
    await page.getByRole('button', { name: 'Página 2 de 3' }).click();
    await expect.poll(current).toBe('Página 2 de 3');
    await page.reload();
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await expect.poll(current).toBe('Página 2 de 3');
  });
});

/** O que o controle de baixo mede em cada tamanho; é o que o relatório da rodada cita. */
async function bottomMetrics(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const found = document.querySelector(selector);
      const r = found?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    };
    const first = (selector: string) => rect(selector);
    const pills = [...document.querySelectorAll('.pill')].map((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    const pillButtons = [...document.querySelectorAll('.pill-btn')].map((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    const rounds = [...document.querySelectorAll('.round-grid .round')].map((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height, y: r.y };
    });
    const icon = document.querySelector('.round app-tv-icon')?.getBoundingClientRect();
    return {
      ring: first('.ring'),
      stage: first('.viewport'),
      bottom: first('.bottom'),
      tv: first('.tv'),
      top: first('.top'),
      pills,
      pillButtons,
      rounds,
      iconSize: icon ? icon.width : null,
      scrollOverflow: document.documentElement.scrollHeight - window.innerHeight,
    };
  });
}

test.describe('botões de baixo e o tamanho escolhido', () => {
  test('compacto, confortável e grande: botões maiores, anel útil e sem rolar de lado', async ({
    page,
  }, info) => {
    await openTv(page);
    const measured: Record<string, Awaited<ReturnType<typeof bottomMetrics>>> = {};
    const shot = (name: string) =>
      screenshot(page, `test-results/tv-header-${name}-${info.project.name}.png`);

    measured['confortável'] = await bottomMetrics(page);
    await shot('size-comfortable');

    for (const [label, key] of [
      ['Compacto', 'compacto'],
      ['Grande', 'grande'],
    ] as const) {
      await titleButton(page).click();
      await choose(page, label);
      await closeCustomize(page);
      await settle(page);
      measured[key] = await bottomMetrics(page);
      await expectNoHorizontalScroll(page);
      await shot(`size-${key}`);
    }
    // Fica em test-results para quem for ler os números (o relatório da rodada cita estes).
    writeFileSync(
      `test-results/tv-header-metrics-${info.project.name}.json`,
      JSON.stringify(measured, null, 2),
    );

    // No 390 (358 úteis) o círculo tem 59,25 px; no 411 (379 úteis), 64,5 px.
    const narrow = info.project.name === 'iphone-12';
    const comfortable = measured['confortável'];
    for (const round of comfortable.rounds) {
      expect(round.width, 'círculo confortável').toBeGreaterThanOrEqual(narrow ? 59 : 62);
      expect(round.height).toBeCloseTo(round.width, 0);
    }
    for (const pill of comfortable.pills) {
      expect(pill.width, 'pílula estreita, de 52 px').toBeLessThanOrEqual(52.5);
    }
    for (const part of comfortable.pillButtons) {
      expect(part.width, 'botão da pílula: 50 px de toque ou mais').toBeGreaterThanOrEqual(49.5);
      expect(part.height, 'botão da pílula: 52 px de altura ou mais').toBeGreaterThanOrEqual(51.5);
    }
    expect(comfortable.iconSize!, 'ícones de 34 px ou mais').toBeGreaterThanOrEqual(34);
    expect(comfortable.bottom!.height, 'bloco de baixo com no máximo 142 px').toBeLessThanOrEqual(
      142.5,
    );
    if (narrow) {
      expect(comfortable.ring!.width, 'anel de 320 px ou mais no 390x664').toBeGreaterThanOrEqual(
        320,
      );
    }
    expect(comfortable.scrollOverflow, 'confortável não rola').toBeLessThanOrEqual(0);
    expect(measured['compacto'].scrollOverflow, 'compacto não rola').toBeLessThanOrEqual(0);
    expect(measured['grande'].scrollOverflow, 'grande não rola').toBeLessThanOrEqual(0);
    expect(measured['compacto'].ring!.width).toBeGreaterThanOrEqual(comfortable.ring!.width - 0.5);

    // Cada tamanho é maior que o anterior (ícones, pílulas e botões), dentro do que a largura da tela deixa.
    expect(measured['grande'].iconSize!).toBeGreaterThan(comfortable.iconSize!);
    expect(comfortable.iconSize!).toBeGreaterThan(measured['compacto'].iconSize!);
    expect(measured['grande'].pills[0].width).toBeGreaterThan(comfortable.pills[0].width);
    expect(comfortable.pills[0].width).toBeGreaterThan(measured['compacto'].pills[0].width);
    expect(measured['grande'].rounds[0].width).toBeGreaterThan(comfortable.rounds[0].width);
    expect(measured['compacto'].rounds[0].width).toBeLessThan(comfortable.rounds[0].width);
  });

  test('sem o canal os círculos aproveitam a largura liberada (até 67 px) e o conjunto fica equilibrado', async ({
    page,
  }, info) => {
    await openTv(page, { showChannel: false });
    const metrics = await bottomMetrics(page);
    expect(metrics.pills).toHaveLength(1);
    for (const round of metrics.rounds) {
      expect(round.width, 'círculo sem o canal').toBeGreaterThanOrEqual(66.5);
      expect(round.width).toBeLessThanOrEqual(67.5);
    }
    // O volume fica colado à esquerda e a grade, de ponta a ponta com ele, sem tocar na pílula nem sair da tela.
    const volume = await box(page.getByRole('group', { name: 'Volume' }));
    const first = await box(page.locator('.round-grid .round').first());
    const last = await box(page.locator('.round-grid .round').nth(3));
    const screen = await page.evaluate(() => window.innerWidth);
    expect(first.x, 'o primeiro círculo não toca na pílula').toBeGreaterThanOrEqual(
      volume.x + volume.width + 2,
    );
    expect(last.x + last.width, 'o último círculo cabe na tela').toBeLessThanOrEqual(screen - 8);
    await expectNoVerticalScroll(page);
    await expectNoHorizontalScroll(page);
    expect(await smallTargets(page)).toEqual([]);
    await screenshot(page, `test-results/tv-header-channel-off-${info.project.name}.png`);
  });

  test('o tamanho grande põe os botões redondos em três colunas, com a última fileira no meio', async ({
    page,
  }) => {
    await openTv(page, { buttonSize: 'large' });
    const rounds = await page.locator('.round-grid .round').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }),
    );
    expect(rounds).toHaveLength(8);
    const rows = [...new Set(rounds.map((r) => Math.round(r.y)))];
    expect(rows).toHaveLength(3);
    const lastRow = rounds.slice(6);
    const grid = await box(page.locator('.round-grid'));
    const gridCenter = grid.x + grid.width / 2;
    expect((lastRow[0].x + lastRow[1].x) / 2).toBeCloseTo(gridCenter, 0);
    await expectNoHorizontalScroll(page);
  });

  test('sem as teclas de mídia sobram quatro botões, em duas colunas', async ({ page }) => {
    await openTv(page, { showMedia: false });
    const rounds = await page
      .locator('.round-grid .round')
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().y)));
    expect(rounds).toHaveLength(4);
    expect(new Set(rounds).size).toBe(2);
    await expectNoVerticalScroll(page);
  });

  test('nenhum tamanho cria rolagem horizontal, nem com tudo escondido', async ({ page }) => {
    await openTv(page);
    for (const buttonSize of ['compact', 'comfortable', 'large']) {
      await reloadWith(page, { buttonSize, showMedia: false, showChannel: false });
      await expectNoHorizontalScroll(page);
      expect(await smallTargets(page), buttonSize).toEqual([]);
    }
  });
});

test.describe('folha de desligar', () => {
  test('tem a linha "Agendar desligamento" marcada "Em breve", que não é um botão', async ({
    page,
  }) => {
    await openTv(page);
    await powerButton(page).click();
    const sheet = powerDialog(page);
    await expect(sheet).toBeVisible();

    // Continua com só dois botões, e o desligar segue pedindo a confirmação.
    await expect(sheet.getByRole('button')).toHaveText(['Cancelar', 'Desligar']);
    const row = sheet.getByRole('group', { name: 'Agendar desligamento' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Em breve');
    await expect(row).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toHaveAccessibleDescription('Ainda não disponível.');
    await expect(row.locator('button, a, input, [tabindex]')).toHaveCount(0);

    // Tocar nela não faz nada, e o teclado não para nela.
    await row.click({ force: true });
    await expect(sheet).toBeVisible();
    expect(tv.count('/power/off')).toBe(0);
    for (let presses = 0; presses < 4; presses++) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() => document.activeElement?.closest('[aria-disabled]')),
      ).toBeNull();
    }
  });

  test('entra subindo e esmaecendo o fundo, e sai do mesmo jeito antes de sumir', async ({
    page,
  }) => {
    await openTv(page);
    // Amostra a opacidade da folha a cada quadro, a partir do toque.
    const entering = await page.evaluate(async () => {
      document.querySelector<HTMLElement>('header .power')!.click();
      const seen: number[] = [];
      const start = performance.now();
      while (performance.now() - start < 450) {
        const dialog = document.querySelector('app-power-sheet dialog');
        if (dialog) seen.push(Number(getComputedStyle(dialog).opacity));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return seen;
    });
    expect(Math.min(...entering), 'a folha partiu quase transparente').toBeLessThan(0.6);
    expect(entering.at(-1), 'e terminou opaca').toBe(1);

    const leaving = await page.evaluate(async () => {
      document.querySelector<HTMLElement>('app-power-sheet dialog .secondary')!.click();
      const seen: number[] = [];
      const start = performance.now();
      while (performance.now() - start < 600) {
        const dialog = document.querySelector('app-power-sheet dialog');
        if (!dialog) return { seen, removedAfter: performance.now() - start };
        seen.push(Number(getComputedStyle(dialog).opacity));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return { seen, removedAfter: null };
    });
    expect(leaving.removedAfter, 'a folha saiu em até 600 ms').not.toBeNull();
    expect(leaving.removedAfter!, 'e esperou a saída, sem sumir de uma vez').toBeGreaterThan(100);
    expect(leaving.removedAfter!, 'sem passar do teto de segurança').toBeLessThan(450);
    expect(Math.min(...leaving.seen), 'esmaeceu antes de sair').toBeLessThan(0.7);
  });

  test('com "reduzir movimento" a folha aparece e some de uma vez', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openTv(page);
    const seen = await page.evaluate(async () => {
      document.querySelector<HTMLElement>('header .power')!.click();
      const values: number[] = [];
      for (let frame = 0; frame < 6; frame++) {
        const dialog = document.querySelector('app-power-sheet dialog');
        if (dialog) values.push(Number(getComputedStyle(dialog).opacity));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return values;
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.min(...seen)).toBe(1);

    const started = Date.now();
    await powerDialog(page).getByRole('button', { name: 'Cancelar' }).click();
    await expect(powerDialog(page)).toHaveCount(0);
    expect(Date.now() - started).toBeLessThan(250);
  });

  test('confirmar ainda desliga uma vez, e o aviso aparece depois que a folha saiu', async ({
    page,
  }) => {
    await openTv(page);
    await powerButton(page).click();
    await powerDialog(page).getByRole('button', { name: 'Desligar', exact: true }).click();
    await expect(powerDialog(page)).toHaveCount(0);
    await expect(
      page.getByText('Pedido de desligar enviado. A TV só volta com o controle original.'),
    ).toBeVisible();
    expect(tv.count('/power/off')).toBe(1);
  });
});

test.describe('aviso passageiro', () => {
  test('entra aparecendo e sai esmaecendo', async ({ page }) => {
    await openTv(page);
    tv.commandFailure = { status: 504, kind: 'agent-timeout' };
    // Amostra a opacidade do aviso a cada quadro assim que a tecla falha.
    const entering = page.evaluate(async () => {
      const seen: number[] = [];
      const start = performance.now();
      while (performance.now() - start < 1500 && seen.length < 8) {
        const toast = document.querySelector('.toast');
        if (toast) seen.push(Number(getComputedStyle(toast).opacity));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return seen;
    });
    await keyButton(page, 'Mudo').click();
    const seen = await entering;
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.min(...seen), 'o aviso partiu transparente').toBeLessThan(0.6);

    // Abrir um painel tira o aviso da tela: ele esmaece antes de sumir.
    await page.waitForTimeout(400);
    const leaving = await page.evaluate(async () => {
      document.querySelector<HTMLElement>('header button[aria-label="Apps da TV"]')!.click();
      const values: number[] = [];
      const start = performance.now();
      while (performance.now() - start < 800) {
        const toast = document.querySelector('.toast');
        if (!toast) return { values, removedAfter: performance.now() - start };
        values.push(Number(getComputedStyle(toast).opacity));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return { values, removedAfter: null };
    });
    expect(leaving.removedAfter, 'o aviso saiu').not.toBeNull();
    expect(leaving.removedAfter!).toBeGreaterThan(60);
    expect(Math.min(...leaving.values)).toBeLessThan(0.8);
  });

  test('com "reduzir movimento" o aviso aparece inteiro e some de uma vez', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openTv(page);
    tv.commandFailure = { status: 504, kind: 'agent-timeout' };
    const entering = page.evaluate(async () => {
      const seen: number[] = [];
      const start = performance.now();
      while (performance.now() - start < 1500 && seen.length < 6) {
        const toast = document.querySelector('.toast');
        if (toast) seen.push(Number(getComputedStyle(toast).opacity));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return seen;
    });
    await keyButton(page, 'Mudo').click();
    const seen = await entering;
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.min(...seen), 'sem transição de entrada').toBe(1);

    // Sem animação de saída (a de movimento dura 200 ms), o aviso some assim que o painel abre.
    const removedAfter = await page.evaluate(async () => {
      document.querySelector<HTMLElement>('header button[aria-label="Apps da TV"]')!.click();
      const start = performance.now();
      while (performance.now() - start < 800) {
        if (!document.querySelector('.toast')) return performance.now() - start;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return null;
    });
    expect(removedAfter, 'o aviso saiu').not.toBeNull();
    expect(removedAfter!, 'sem esperar uma animação de saída').toBeLessThan(180);
  });
});

test.describe('paisagem curta (844x390)', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('cabeçalho numa linha, nome no meio e os botões de baixo dentro da coluna da direita', async ({
    page,
  }, info) => {
    await openTv(page);
    await expectTitleCentered(page);
    await expectNoHorizontalScroll(page);
    await expectNoVerticalScroll(page);
    expect(await smallTargets(page)).toEqual([]);

    const tvBox = await box(page.locator('.tv'));
    const bottom = await box(page.locator('.bottom'));
    const top = await box(page.locator('.top'));
    expect(
      bottom.y + bottom.height,
      'os botões de baixo terminam dentro da tela',
    ).toBeLessThanOrEqual(tvBox.y + tvBox.height + 0.5);
    expect(
      top.y + top.height,
      'a fileira de cima não passa por cima dos botões de baixo',
    ).toBeLessThanOrEqual(bottom.y + 0.5);
    const head = await box(header(page));
    expect(head.height).toBeLessThanOrEqual(46);
    await screenshot(page, `test-results/tv-header-landscape-${info.project.name}.png`);

    for (const buttonSize of ['compact', 'large']) {
      await reloadWith(page, { buttonSize });
      await expectNoHorizontalScroll(page);
      const b = await box(page.locator('.bottom'));
      const t = await box(page.locator('.top'));
      expect(t.y + t.height, `${buttonSize}: sem sobrepor a fileira de cima`).toBeLessThanOrEqual(
        b.y + 0.5,
      );
      await screenshot(
        page,
        `test-results/tv-header-landscape-${buttonSize}-${info.project.name}.png`,
      );
    }
  });

  test('nome longo em paisagem também fica no meio, sem tocar nos botões', async ({ page }) => {
    await openTv(page, { name: LONG_NAME });
    await expectTitleCentered(page);
    await expectNoHorizontalScroll(page);
  });
});
