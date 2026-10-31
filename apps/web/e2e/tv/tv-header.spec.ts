import { writeFileSync } from 'node:fs';
import { Locator, Page } from '@playwright/test';
import { GUEST, IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { TvMock, emitSse, installFakeEventSource, mockTvApi, sseUrls } from './tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const PREFS_KEY = 'uniover.tv.prefs.v2.u1';
/** O apelido mais longo que o cabeçalho comporta (20 letras), um nome de verdade e com espaços. */
const LONG_NAME = 'Casa da praia - sala';
/**
 * Nomes curtos, com espaços: aparecem inteiros em até duas linhas (a regra do produto), qualquer que seja a fonte.
 */
const SHORT_NAMES = ['TV', 'Sala 1', 'Quarto 12', 'TV da sala', 'Sala de TV', 'Casa de Ana'];
/**
 * Nomes de 13 a 20 letras, e a palavra única de 20 letras. A largura do texto depende da fonte do sistema (a do Linux
 * é bem mais larga que a do Windows, e a do iPhone fica no meio), então aqui o que se garante é o pior caso degradar
 * bem: sem passar da coluna nem dos 44 px, no meio da tela e longe dos botões; se não couber em duas linhas, o corte
 * é do `line-clamp`, e o nome inteiro segue no nome acessível e na folha Personalizar.
 */
const LONG_NAMES = [
  'Sala de estar',
  'TV do Neemias',
  'Quarto de hóspedes',
  'TV da sala de estar',
  'Televisaodasalaestar',
  LONG_NAME,
];
/** Uma fonte larga (a do Linux é parecida), posta na raiz do corpo pelo CSSOM, que a política de CSP permite. */
const WIDE_FONT = 'Verdana, "DejaVu Sans", sans-serif';

let identity: IdentityMock;
let tv: TvMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  tv = await mockTvApi(context, identity);
  await installFakeEventSource(page);
});

test('keeps the old unscoped TV preferences inert instead of assigning them to the account', async ({
  page,
}) => {
  await page.goto('/entrar');
  await page.evaluate(() =>
    localStorage.setItem('uniover.tv.prefs.v1', JSON.stringify({ name: 'Conta anterior' })),
  );
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/tv');
  await expect(page.getByRole('button', { name: 'TV, personalizar' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('uniover.tv.prefs.v1'))).toBe(
    JSON.stringify({ name: 'Conta anterior' }),
  );
  expect(await page.evaluate(() => localStorage.getItem('uniover.tv.prefs.v2.u1'))).toBeNull();
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
  await page.evaluate((value) => {
    const accountId = localStorage.getItem('uniover.account-id');
    if (!accountId) throw new Error('Conta de teste sem identidade local');
    localStorage.setItem(
      `uniover.tv.prefs.v2.${encodeURIComponent(accountId)}`,
      JSON.stringify(value),
    );
  }, prefs);
  await page.reload();
  await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
  await emitSse(page, 'tv.state', tv.state);
  await emitSse(page, 'tv.shortcuts', tv.shortcuts);
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeVisible();
  await settle(page);
}

const header = (page: Page) => page.locator('.tv > header.head');
const backLink = (page: Page) => header(page).getByRole('link', { name: 'Voltar ao Início' });
const menuButton = (page: Page) => header(page).getByRole('button', { name: 'Mais opções' });
const menuDialog = (page: Page) => page.getByRole('dialog', { name: 'Mais opções' });

/** Abre o painel Apps pelo caminho de quem usa a tela: os três pontos e, no menu, a linha dos apps. */
async function openAppsFromMenu(page: Page) {
  await menuButton(page).click();
  await expect(menuDialog(page)).toBeVisible();
  await menuDialog(page).getByRole('button', { name: 'Apps da TV' }).click();
}
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

/**
 * O centro do nome (o texto, e também o <h1>) tem de coincidir com o centro da TELA, com ou sem a seta do seletor de TV. À
 * esquerda ficam a seta de voltar e os três pontos; à direita, o ponto de estado, colado à esquerda do desligar, e o
 * desligar. O ponto fica longe do nome.
 */
async function expectTitleCentered(page: Page) {
  const viewport = await page.evaluate(() => window.innerWidth);
  const title = await box(header(page).locator('h1'));
  expect(Math.abs(title.x + title.width / 2 - viewport / 2), 'centro do nome').toBeLessThanOrEqual(
    2,
  );
  const text = await box(header(page).locator('.title-text'));
  expect(
    Math.abs(text.x + text.width / 2 - viewport / 2),
    'centro do texto do nome, seja qual for o que há ao lado',
  ).toBeLessThanOrEqual(2);

  const head = await box(header(page));
  const back = await box(backLink(page));
  const menu = await box(menuButton(page));
  const dot = await box(statusDot(page));
  const power = await box(powerButton(page));
  expect(Math.abs(back.x - head.x), 'a seta na ponta esquerda').toBeLessThanOrEqual(1);
  expect(Math.abs(menu.y - back.y), 'o menu na mesma linha da seta').toBeLessThanOrEqual(1);
  expect(menu.x - (back.x + back.width), 'o menu logo depois da seta').toBeGreaterThanOrEqual(3);
  expect(menu.x - (back.x + back.width), 'e perto dela').toBeLessThanOrEqual(10);
  expect(menu.x + menu.width, 'o menu não encosta no nome').toBeLessThanOrEqual(title.x + 0.5);
  expect(dot.x, 'o ponto fica depois do nome').toBeGreaterThanOrEqual(title.x + title.width - 0.5);
  expect(
    power.x - (dot.x + dot.width),
    'o ponto colado à esquerda do desligar',
  ).toBeGreaterThanOrEqual(-0.5);
  expect(power.x - (dot.x + dot.width), 'e perto dele').toBeLessThanOrEqual(8);
  expect(
    Math.abs(dot.y + dot.height / 2 - (power.y + power.height / 2)),
    'o ponto e o desligar no mesmo eixo',
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(power.x + power.width - (head.x + head.width)),
    'o desligar na ponta direita',
  ).toBeLessThanOrEqual(1);
  expect(dot.x + dot.width, 'o ponto cabe na tela').toBeLessThanOrEqual(viewport);
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

/** Troca a fonte do app por uma larga (só no teste; o CSSOM não esbarra na CSP). */
async function useWideFont(page: Page) {
  await page.evaluate(
    (family) => document.body.style.setProperty('font-family', family),
    WIDE_FONT,
  );
}

/**
 * O nome mede o que o texto mede na fonte do aparelho. Este é o piso, para qualquer nome e qualquer fonte: o texto não
 * passa da largura da coluna e o título cabe nos 44 px do cabeçalho (o que sobra do nome é cortado pelo `line-clamp`).
 */
async function expectTitleContained(page: Page) {
  const found = await titleMetrics(page);
  expect(found.overflowsWidth, 'o nome não passa da largura da coluna').toBe(false);
  expect(found.headingHeight, 'o nome cabe nos 44 px do cabeçalho').toBeLessThanOrEqual(44.5);
  return found;
}

/** As linhas contam-se pelas caixas do texto, e não pela altura, que o corte esconderia. */
async function titleMetrics(page: Page) {
  return header(page)
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
}

/** Nome curto: inteiro, em até duas linhas, sem reticências (nem o corte do `line-clamp`). */
async function expectTitleWhole(page: Page) {
  const found = await expectTitleContained(page);
  expect(found.lines, 'o nome cabe em até duas linhas, sem reticências').toBeLessThanOrEqual(2);
  return found;
}

async function choose(page: Page, label: string) {
  await customizeDialog(page).getByRole('button', { name: label, exact: true }).click();
}

async function closeCustomize(page: Page) {
  await customizeDialog(page).getByRole('button', { name: 'Concluir' }).click();
  await expect(customizeDialog(page)).toHaveCount(0);
}

test.describe('cabeçalho: voltar, energia, nome e menu', () => {
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

    for (const target of [back, menuButton(page), powerButton(page)]) {
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
    expect(await style(menuButton(page))).toEqual(await style(powerButton(page)));

    await screenshot(page, `test-results/tv-header-default-${info.project.name}.png`);
  });

  test('o topo: voltar e os três pontos à esquerda, o nome no centro e, à direita, o ponto de estado e o desligar', async ({
    page,
  }) => {
    await openTv(page);
    await expectTitleCentered(page);
    await expect(header(page).locator('.lead').getByRole('link')).toHaveCount(1);
    await expect(header(page).locator('.lead').getByRole('button')).toHaveCount(1);
    // Ponto e desligar à direita, e nenhuma engrenagem em lugar nenhum do topo.
    await expect(header(page).locator('.actions').getByRole('button')).toHaveCount(2);
    await expect(header(page).getByRole('link', { name: 'Configurações' })).toHaveCount(0);

    // O desenho são três pontos na vertical (um traço mais alto que largo).
    const shape = await menuButton(page)
      .locator('svg path')
      .evaluate((el) => {
        const bounds = (el as SVGGraphicsElement).getBBox();
        return {
          width: bounds.width,
          height: bounds.height,
          parts: (el.getAttribute('d') ?? '').match(/M/g)?.length,
        };
      });
    expect(shape.parts, 'três pontos').toBe(3);
    expect(shape.height, 'na vertical').toBeGreaterThan(shape.width * 4);
  });

  test('a tabulação segue da esquerda para a direita', async ({ page }) => {
    await openTv(page);
    await backLink(page).focus();
    await page.keyboard.press('Tab');
    await expect(menuButton(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(titleButton(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(statusDot(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(powerButton(page)).toBeFocused();
  });

  test('o nome é o da TV, no meio da tela, com o ponto de estado junto do desligar', async ({
    page,
  }) => {
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

  for (const wide of [false, true]) {
    test(`nomes de 1 a 20 letras no meio da tela, sem estourar a coluna, ${wide ? 'com uma fonte larga' : 'na fonte do aparelho'}`, async ({
      page,
    }, info) => {
      await openTv(page);
      const seen: unknown[] = [];
      for (const name of [...SHORT_NAMES, ...LONG_NAMES]) {
        await reloadWith(page, { name });
        if (wide) await useWideFont(page);
        await expect(header(page).getByRole('heading', { level: 1 })).toHaveText(name);
        await expect(titleButton(page)).toHaveAccessibleName(`${name}, personalizar`);
        await expectTitleCentered(page);
        await expectNoHorizontalScroll(page);
        const found = SHORT_NAMES.includes(name)
          ? await expectTitleWhole(page)
          : await expectTitleContained(page);
        seen.push({ name, ...found });
      }
      // Fica em test-results para quem for ler os números (o relatório da rodada cita estes).
      writeFileSync(
        `test-results/tv-header-title-${wide ? 'wide-' : ''}${info.project.name}.json`,
        JSON.stringify(seen, null, 2),
      );
    });
  }

  test('o nome mais longo: no meio, contido e o painelzinho do ponto dentro da tela', async ({
    page,
  }, info) => {
    await openTv(page, { name: LONG_NAME });
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText(LONG_NAME);
    await expectTitleCentered(page);
    await expectTitleContained(page);
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

  test('apelido curto, médio e longo: a classe do tamanho muda e o nome fica no meio, longe dos botões', async ({
    page,
  }, info) => {
    await openTv(page);
    for (const [size, name] of [
      ['short', 'Sala 1'],
      ['medium', 'Sala de TV'],
      ['long', LONG_NAME],
    ] as const) {
      await reloadWith(page, { name });
      await expect(header(page).locator('.name')).toHaveAttribute('data-size', size);
      await expectTitleCentered(page);
      await expectTitleContained(page);
      await expectNoHorizontalScroll(page);
      await screenshot(page, `test-results/tv-header-name-${size}-owner-${info.project.name}.png`);
    }
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

  test('o menu do cabeçalho leva ao painel Apps mesmo sem agente', async ({ page }) => {
    await openTv(page);
    await expect(menuButton(page)).toHaveAttribute('aria-haspopup', 'dialog');
    // Sem agente os botões da TV apagam, mas o painel lê a lista guardada.
    await emitSse(page, 'tv.state', {
      ...tv.state,
      agentOnline: false,
      connection: 'disconnected',
    });
    await expect(powerButton(page)).toBeDisabled();
    await expect(menuButton(page)).toBeEnabled();

    await openAppsFromMenu(page);
    const dialog = page.getByRole('dialog', { name: 'Apps da TV' });
    await expect(dialog).toBeVisible();
    // O foco que volta ao botão ao fechar é provado em tv.spec.ts ("devolve o foco ao botão do cabeçalho").
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('o painel Apps abre pelo menu do cabeçalho, com o controle por trás, e passa no axe', async ({
    page,
  }, info) => {
    await openTv(page);
    await openAppsFromMenu(page);
    const dialog = page.getByRole('dialog', { name: 'Apps da TV' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.item')).toHaveCount(tv.shortcuts.length);
    await settle(page);
    await expectNoA11yViolations(page);
    await screenshot(page, `test-results/tv-header-apps-panel-${info.project.name}.png`);
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
      // Sem movimento: o axe não pode ler uma cor no meio de uma transição.
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await expectNoA11yViolations(page);
      await screenshot(page, `test-results/tv-header-owner-${scheme}-${info.project.name}.png`);

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
      // Os atalhos de cima passaram de 52 para 60 px (pedido do dono): os 8 px a mais saem da altura do anel, que ficou
      // com 318 px no 390x664 (eram 326). O piso é 316.
      expect(comfortable.ring!.width, 'anel de 316 px ou mais no 390x664').toBeGreaterThanOrEqual(
        316,
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

  test('o tamanho grande põe os botões redondos em três colunas, e a Fonte fecha a última fileira', async ({
    page,
  }) => {
    await openTv(page, { buttonSize: 'large' });
    const rounds = await page.locator('.round-grid .round').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }),
    );
    // Oito botões fixos em três colunas deixariam um buraco: a Fonte, que a TV tem, é o nono.
    expect(rounds).toHaveLength(9);
    const rows = [...new Set(rounds.map((r) => r.y))];
    expect(rows).toHaveLength(3);
    for (const y of rows) expect(rounds.filter((r) => r.y === y)).toHaveLength(3);
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

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * O que o bloco de baixo mede, nas duas disposições das pílulas: anel, palco, bloco, as duas pílulas, os botões delas e
 * os redondos. É o que o relatório da rodada cita (em test-results, em JSON).
 */
async function layoutMetrics(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null): Rect | null => {
      const r = el?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    };
    const group = (name: string) =>
      document.querySelector(`.bottom [role="group"][aria-label="${name}"]`);
    return {
      ring: rect(document.querySelector('.ring')),
      stage: rect(document.querySelector('.viewport')),
      bottom: rect(document.querySelector('.bottom')),
      volume: rect(group('Volume')),
      channel: rect(group('Canal')),
      pillButtons: [...document.querySelectorAll('.bottom .pill-btn')].map((el) => rect(el)!),
      rounds: [...document.querySelectorAll('.round-grid .round')].map((el) => rect(el)!),
      scrollOverflow: document.documentElement.scrollHeight - window.innerHeight,
    };
  });
}

const PILLS_LABEL = 'Disposição dos botões de volume e canal';
const distinct = (values: number[]) => new Set(values.map((v) => Math.round(v / 4))).size;

test.describe('disposição das pílulas de volume e canal', () => {
  test('Personalizar oferece as duas disposições; a escolha vale atrás da folha, fica depois de recarregar e volta ao padrão', async ({
    page,
  }, info) => {
    await openTv(page);
    const sides = await layoutMetrics(page);
    await expect(page.locator('.bottom')).toHaveAttribute('data-pills', 'sides');

    await titleButton(page).click();
    const sheet = customizeDialog(page);
    const group = sheet.getByRole('group', { name: PILLS_LABEL });
    await expect(group.getByRole('button')).toHaveText(['Nas laterais', 'Em fileira, acima']);
    await expect(group.getByRole('button', { name: 'Nas laterais' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await group.getByRole('button', { name: 'Em fileira, acima' }).click();
    await expect(group.getByRole('button', { name: 'Em fileira, acima' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Vale na hora, com a folha ainda aberta: o controle por trás já mudou.
    await expect(page.locator('.bottom')).toHaveAttribute('data-pills', 'row');
    await closeCustomize(page);
    await settle(page);

    const row = await layoutMetrics(page);
    const narrow = info.project.name === 'iphone-12';
    // Em pé nas laterais; deitadas e lado a lado na fileira, as duas na mesma altura e acima dos botões redondos.
    expect(sides.volume!.height).toBeGreaterThan(sides.volume!.width);
    expect(row.volume!.width).toBeGreaterThan(row.volume!.height * 2);
    expect(
      Math.abs(row.volume!.y - row.channel!.y),
      'as pílulas na mesma altura',
    ).toBeLessThanOrEqual(1);
    expect(row.volume!.x + row.volume!.width, 'volume à esquerda do canal').toBeLessThanOrEqual(
      row.channel!.x,
    );
    expect(
      Math.abs(row.volume!.width - row.channel!.width),
      'pílulas do mesmo tamanho',
    ).toBeLessThanOrEqual(1);
    expect(row.volume!.y + row.volume!.height, 'as pílulas acima dos redondos').toBeLessThanOrEqual(
      Math.min(...row.rounds.map((r) => r.y)),
    );
    // Quatro colunas por duas fileiras de botões redondos, maiores que nas laterais; o anel cede a altura.
    expect(distinct(row.rounds.map((r) => r.x))).toBe(4);
    expect(distinct(row.rounds.map((r) => r.y))).toBe(2);
    expect(row.rounds[0].width, 'círculos maiores').toBeGreaterThanOrEqual(narrow ? 70 : 80);
    expect(row.rounds[0].width).toBeGreaterThan(sides.rounds[0].width + 8);
    // Com a altura devolvida pelos pontos compactados, no 411x800 o anel já é limitado pela largura nas duas disposições.
    expect(row.ring!.width, 'o anel não cresce').toBeLessThanOrEqual(sides.ring!.width);
    expect(row.scrollOverflow, 'sem rolagem').toBeLessThanOrEqual(0);
    await expectNoHorizontalScroll(page);
    expect(await smallTargets(page)).toEqual([]);

    // Fica depois de recarregar, na mesma chave das outras escolhas.
    await page.reload();
    await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await expect(page.locator('.bottom')).toHaveAttribute('data-pills', 'row');
    expect(
      await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? '{}').pillLayout,
        PREFS_KEY,
      ),
    ).toBe('row');

    // Restaurar padrão traz as pílulas de volta às laterais.
    await titleButton(page).click();
    await sheet.getByRole('button', { name: 'Restaurar padrão' }).click();
    await expect(page.locator('.bottom')).toHaveAttribute('data-pills', 'sides');
    await expect(sheet.getByRole('button', { name: 'Restaurar padrão' })).toBeDisabled();
    await expect(
      sheet.getByRole('group', { name: PILLS_LABEL }).getByRole('button', { name: 'Nas laterais' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('uma escolha guardada antes de existir a disposição abre com as pílulas nas laterais', async ({
    page,
  }) => {
    await openTv(page, { buttonSize: 'large', showMedia: false });
    await expect(page.locator('.bottom')).toHaveAttribute('data-pills', 'sides');
    const metrics = await layoutMetrics(page);
    expect(metrics.volume!.height).toBeGreaterThan(metrics.volume!.width);
    // O que estava guardado segue valendo: tamanho grande e sem as teclas de mídia.
    await expect(keyButton(page, 'Mudo')).toHaveCount(0);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`as duas disposições nos três tamanhos: medidas, sem rolagem de lado e alvos de 44 px (tema ${scheme})`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await openTv(page);
      const measured: Record<string, Awaited<ReturnType<typeof layoutMetrics>>> = {};
      for (const pillLayout of ['sides', 'row'] as const) {
        for (const buttonSize of ['compact', 'comfortable', 'large'] as const) {
          await reloadWith(page, { pillLayout, buttonSize });
          const key = `${pillLayout}-${buttonSize}`;
          measured[key] = await layoutMetrics(page);
          await expectNoHorizontalScroll(page);
          expect(await smallTargets(page), key).toEqual([]);
          await screenshot(
            page,
            `test-results/tv-layout-${key}-${scheme}-${info.project.name}.png`,
          );
        }
      }
      // Fica em test-results para quem for ler os números (o relatório da rodada cita estes).
      writeFileSync(
        `test-results/tv-layout-metrics-${scheme}-${info.project.name}.json`,
        JSON.stringify(measured, null, 2),
      );

      for (const [key, found] of Object.entries(measured)) {
        expect(found.scrollOverflow, `${key} não rola`).toBeLessThanOrEqual(0);
        for (const part of found.pillButtons) {
          expect(part.width, `${key}: botão da pílula`).toBeGreaterThanOrEqual(43.5);
          expect(part.height, `${key}: botão da pílula`).toBeGreaterThanOrEqual(43.5);
        }
      }
      // Cada tamanho é maior que o anterior, nas duas disposições.
      for (const pillLayout of ['sides', 'row']) {
        const [compact, comfortable, large] = ['compact', 'comfortable', 'large'].map(
          (size) => measured[`${pillLayout}-${size}`].rounds[0].width,
        );
        expect(compact, pillLayout).toBeLessThan(comfortable);
        expect(comfortable, pillLayout).toBeLessThan(large);
      }
    });
  }

  test('sem o canal a pílula de volume ocupa a fileira inteira e os círculos não encolhem', async ({
    page,
  }, info) => {
    await openTv(page, { pillLayout: 'row', showChannel: false });
    const found = await layoutMetrics(page);
    expect(found.channel).toBeNull();
    const grid = await box(page.locator('.round-grid'));
    expect(
      Math.abs(found.volume!.width - grid.width),
      'a pílula tem a largura dos botões',
    ).toBeLessThanOrEqual(2);
    expect(found.volume!.x).toBeGreaterThanOrEqual(0);
    expect(found.volume!.y + found.volume!.height).toBeLessThanOrEqual(
      Math.min(...found.rounds.map((r) => r.y)),
    );
    expect(found.rounds[0].width, 'sem o canal os círculos seguem grandes').toBeGreaterThanOrEqual(
      info.project.name === 'iphone-12' ? 70 : 80,
    );
    expect(found.scrollOverflow).toBeLessThanOrEqual(0);
    await expectNoHorizontalScroll(page);
    expect(await smallTargets(page)).toEqual([]);
    await screenshot(page, `test-results/tv-layout-row-channel-off-${info.project.name}.png`);
  });

  test('sem as teclas de mídia os quatro botões redondos ficam numa fileira só', async ({
    page,
  }) => {
    await openTv(page, { pillLayout: 'row', showMedia: false });
    const found = await layoutMetrics(page);
    expect(found.rounds).toHaveLength(4);
    expect(distinct(found.rounds.map((r) => r.y))).toBe(1);
    expect(found.scrollOverflow).toBeLessThanOrEqual(0);
    await expectNoHorizontalScroll(page);
  });

  test('em fileira o Tab anda na ordem em que se vê: volume, canal e os botões redondos', async ({
    page,
  }) => {
    await openTv(page, { pillLayout: 'row' });
    const order = await page.locator('.bottom').evaluate((el) =>
      [...el.querySelectorAll('button')].map((button) => {
        const r = button.getBoundingClientRect();
        return { name: button.getAttribute('aria-label'), x: r.x, y: r.y };
      }),
    );
    expect(order.slice(0, 4).map((b) => b.name)).toEqual([
      'Diminuir o volume',
      'Aumentar o volume',
      'Canal anterior',
      'Próximo canal',
    ]);
    // Cada botão vem depois do anterior na leitura: numa linha mais abaixo, ou na mesma linha mais à direita.
    for (let index = 1; index < order.length; index++) {
      const before = order[index - 1];
      const now = order[index];
      const nextLine = now.y > before.y + 8;
      const sameLineToTheRight = Math.abs(now.y - before.y) <= 8 && now.x > before.x;
      expect(nextLine || sameLineToTheRight, `${before.name} -> ${now.name}`).toBe(true);
    }
  });

  test('os botões de volume e canal seguem mandando as mesmas teclas, nas duas disposições', async ({
    page,
  }) => {
    await openTv(page, { pillLayout: 'row' });
    for (const [name, key] of [
      ['Aumentar o volume', 'VOLUME_UP'],
      ['Diminuir o volume', 'VOLUME_DOWN'],
      ['Próximo canal', 'CHANNEL_UP'],
      ['Canal anterior', 'CHANNEL_DOWN'],
    ] as const) {
      const before = tv.keysSent().length;
      await keyButton(page, name).click();
      await expect.poll(() => tv.keysSent().slice(before), name).toEqual([key]);
    }
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`em fileira, o controle e a folha Personalizar passam no axe (tema ${scheme})`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await openTv(page, { pillLayout: 'row' });
      await expectNoA11yViolations(page);

      await titleButton(page).click();
      await expect(customizeDialog(page)).toBeVisible();
      await settle(page);
      await expectNoA11yViolations(page);
      await screenshot(page, `test-results/tv-customize-top-${scheme}-${info.project.name}.png`);
      // O bloco novo à vista: a folha rola por dentro quando não cabe.
      await customizeDialog(page)
        .getByRole('group', { name: PILLS_LABEL })
        .scrollIntoViewIfNeeded();
      await screenshot(page, `test-results/tv-customize-layout-${scheme}-${info.project.name}.png`);
      expect(await smallTargets(page)).toEqual([]);
      await expectNoHorizontalScroll(page);
    });
  }
});

test.describe('folha de desligar', () => {
  test('explica quando o agente ainda não oferece agendamento seguro', async ({ page }) => {
    await openTv(page);
    await powerButton(page).click();
    const sheet = powerDialog(page);
    await expect(sheet).toBeVisible();

    // O desligar imediato continua disponível, mesmo quando o agente não oferece a operação segura.
    await expect(sheet.getByRole('button')).toHaveText(['Desligar', 'Cancelar']);
    const row = sheet.getByRole('region', { name: 'Agendar' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Agendamento disponível com TV configurada');
    await expect(row.locator('button, input')).toHaveCount(0);
    expect(tv.count('/power/off')).toBe(0);
  });

  test('confirma a hora local, altera e cancela o agendamento', async ({ page }) => {
    tv.tvs = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'TV',
        isDefault: true,
        agentSlug: 'pc-casa',
        kind: 'android',
        online: true,
        capabilities: ['tv.remote', 'tv.kind.android', 'tv.power.off.v1'],
      },
    ];
    await openTv(page);
    await powerButton(page).click();
    const sheet = powerDialog(page);
    await expect(sheet).toBeVisible();
    // Os tempos prontos são chips, na ordem do pedido; "Personalizar" abre o horário do dia.
    await expect(sheet.locator('.chip')).toHaveText([
      '15 min',
      '30 min',
      '1 h',
      '2 h',
      'Personalizar',
    ]);
    await expect(powerButton(page).locator('.scheduled')).toHaveCount(0);
    await sheet.getByRole('button', { name: '30 min' }).click();
    await expect(sheet.getByRole('button', { name: '30 min' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await sheet.getByRole('button', { name: /^Agendar para \d{2}:\d{2}$/ }).click();
    await expect(sheet.locator('.schedule-active')).toContainText(/Desliga às \d{2}:\d{2}/);
    await expect(sheet.locator('.schedule-active .left')).toContainText(/^em (29|30) min$/);
    // O botão de energia ganha o relógio miúdo; a hora e o tempo que falta ficam só dentro da folha.
    await expect(powerButton(page).locator('.scheduled')).toHaveCount(1);
    await sheet.getByRole('button', { name: '1 h' }).click();
    await sheet.getByRole('button', { name: /^Agendar para \d{2}:\d{2}$/ }).click();
    await expect
      .poll(
        () =>
          tv.requests.filter(
            (request) => request.method === 'PUT' && request.path === '/power/schedule',
          ).length,
      )
      .toBe(2);
    await sheet.getByRole('button', { name: 'Cancelar Agendamento' }).click();
    await expect(sheet).not.toContainText('Desliga às');
    await expect(powerButton(page).locator('.scheduled')).toHaveCount(0);
    expect(tv.count('/power/off')).toBe(0);
    expect(await smallTargets(page)).toEqual([]);
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
  });

  test('o botão Desligar fica visível sem rolar, mesmo com o agendamento aberto', async ({
    page,
  }, info) => {
    tv.tvs = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'TV',
        isDefault: true,
        agentSlug: 'pc-casa',
        kind: 'android',
        online: true,
        capabilities: ['tv.remote', 'tv.kind.android', 'tv.power.off.v1'],
      },
    ];
    await openTv(page);
    await powerButton(page).click();
    const sheet = powerDialog(page);
    await expect(sheet).toBeVisible();
    // O estado mais alto da folha: atalho escolhido, com a confirmação do horário na tela.
    await sheet.getByRole('button', { name: '30 min' }).click();
    await expect(sheet.getByRole('button', { name: /^Agendar para/ })).toBeAttached();
    const off = sheet.getByRole('button', { name: 'Desligar', exact: true });
    await expect
      .poll(async () => {
        const box = await off.boundingBox();
        const height = page.viewportSize()!.height;
        return box !== null && box.y >= 0 && box.y + box.height <= height + 0.5;
      })
      .toBe(true);
    await screenshot(page, `test-results/config-2/power-schedule-${info.project.name}.png`);
  });

  test('entra por transição (parte do @starting-style) e sai marcada como saindo antes de sumir', async ({
    page,
  }) => {
    await openTv(page);
    const startingStyle = await page.evaluate(
      () =>
        typeof (window as unknown as { CSSStartingStyleRule?: unknown }).CSSStartingStyleRule !==
        'undefined',
    );
    test.skip(!startingStyle, 'este navegador não tem @starting-style: a folha só aparece');

    // O observador é armado ANTES de abrir: a transição que sai do estado inicial dispara `transitionrun` assim que
    // nasce, não importa quando o teste olhar (um executor lento perde a janela de uma amostragem por quadro).
    await page.evaluate(() => {
      const w = window as unknown as { __runs: string[] };
      w.__runs = [];
      document.addEventListener(
        'transitionrun',
        (event) => {
          if ((event.target as HTMLElement).tagName === 'DIALOG') w.__runs.push(event.propertyName);
        },
        true,
      );
    });
    await powerButton(page).click();
    await expect(powerDialog(page)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __runs: string[] }).__runs))
      .toEqual(expect.arrayContaining(['opacity', 'transform']));
    await expect
      .poll(() => powerDialog(page).evaluate((el) => getComputedStyle(el).opacity))
      .toBe('1');

    // A saída: o pedido marca a folha como saindo no mesmo instante, e só então ela some (o teto é de segurança).
    const leaving = await page.evaluate(async () => {
      document.querySelector<HTMLElement>('app-power-sheet dialog .close')!.click();
      let markedClosing = false;
      const start = performance.now();
      while (performance.now() - start < 3000) {
        const dialog = document.querySelector('app-power-sheet dialog');
        if (!dialog) return { markedClosing, removed: true };
        if (dialog.hasAttribute('data-closing')) markedClosing = true;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return { markedClosing, removed: false };
    });
    expect(leaving.markedClosing, 'a folha passou pelo estado de saída').toBe(true);
    expect(leaving.removed, 'e depois saiu').toBe(true);
  });

  test('com "reduzir movimento" a folha aparece sem transição e some sem passar pela saída', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openTv(page);
    await powerButton(page).click();
    await expect(powerDialog(page)).toBeVisible();
    expect(
      await powerDialog(page).evaluate((el) => ({
        opacity: getComputedStyle(el).opacity,
        transition: getComputedStyle(el).transitionDuration,
        running: el.getAnimations().length,
      })),
    ).toEqual({ opacity: '1', transition: '0s', running: 0 });

    // Sem saída animada: a folha nunca é marcada como saindo, e vai embora.
    const leaving = await page.evaluate(async () => {
      document.querySelector<HTMLElement>('app-power-sheet dialog .close')!.click();
      let markedClosing = false;
      const start = performance.now();
      while (performance.now() - start < 3000) {
        const dialog = document.querySelector('app-power-sheet dialog');
        if (!dialog) return { markedClosing, removed: true };
        if (dialog.hasAttribute('data-closing')) markedClosing = true;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return { markedClosing, removed: false };
    });
    expect(leaving.markedClosing, 'sem estado de saída').toBe(false);
    expect(leaving.removed).toBe(true);
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
  /** Amostra, quadro a quadro, o aviso: se existe, com que classes e quantas animações rodam nele. */
  async function watchToastLeave(page: Page) {
    return page.evaluate(async () => {
      document.querySelector<HTMLElement>('header button[aria-label="Mais opções"]')!.click();
      let sawLeaveClass = false;
      let sawAnimation = false;
      const start = performance.now();
      while (performance.now() - start < 3000) {
        const toast = document.querySelector('.toast');
        if (!toast) return { sawLeaveClass, sawAnimation, removed: true };
        if (toast.classList.contains('toast-leave')) sawLeaveClass = true;
        if (toast.getAnimations().length > 0) sawAnimation = true;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return { sawLeaveClass, sawAnimation, removed: false };
    });
  }

  test('entra por transição e sai marcado como saindo antes de sumir', async ({ page }) => {
    await openTv(page);
    const startingStyle = await page.evaluate(
      () =>
        typeof (window as unknown as { CSSStartingStyleRule?: unknown }).CSSStartingStyleRule !==
        'undefined',
    );
    test.skip(!startingStyle, 'este navegador não tem @starting-style: o aviso só aparece');

    // Observador armado antes de a tecla falhar (ver a folha de desligar): não depende do quadro em que o teste olha.
    await page.evaluate(() => {
      const w = window as unknown as { __runs: string[] };
      w.__runs = [];
      document.addEventListener(
        'transitionrun',
        (event) => {
          if ((event.target as HTMLElement).classList?.contains('toast'))
            w.__runs.push(event.propertyName);
        },
        true,
      );
    });
    tv.commandFailure = { status: 504, kind: 'agent-timeout' };
    await keyButton(page, 'Mudo').click();
    await expect(page.locator('.toast')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __runs: string[] }).__runs))
      .toContain('opacity');

    // Abrir um painel tira o aviso da tela: ele passa pela classe de saída (a animação do Angular) antes de sumir.
    await expect
      .poll(() => page.locator('.toast').evaluate((el) => getComputedStyle(el).opacity))
      .toBe('1');
    const leaving = await watchToastLeave(page);
    expect(leaving.sawLeaveClass, 'o aviso foi marcado como saindo').toBe(true);
    expect(leaving.removed, 'e depois saiu').toBe(true);
  });

  test('com "reduzir movimento" o aviso aparece inteiro e some sem passar pela saída', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openTv(page);
    tv.commandFailure = { status: 504, kind: 'agent-timeout' };
    await keyButton(page, 'Mudo').click();
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible();
    expect(
      await toast.evaluate((el) => ({
        opacity: getComputedStyle(el).opacity,
        transition: getComputedStyle(el).transitionDuration,
        running: el.getAnimations().length,
      })),
    ).toEqual({ opacity: '1', transition: '0s', running: 0 });

    // O Angular põe a classe de saída em qualquer caso (e a tira no quadro seguinte, se nada anima); com movimento reduzido
    // o CSS não a liga a nenhuma animação, então o que vale é o estado: nunca houve animação em andamento e o aviso saiu.
    const leaving = await watchToastLeave(page);
    expect(leaving.sawAnimation, 'sem animação em andamento').toBe(false);
    expect(leaving.removed).toBe(true);
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

  test('com as pílulas em fileira o bloco de baixo segue na coluna da direita, sem sobrepor e sem rolar', async ({
    page,
  }, info) => {
    await openTv(page, { pillLayout: 'row' });
    const measured: Record<string, Awaited<ReturnType<typeof layoutMetrics>>> = {};
    for (const buttonSize of ['compact', 'comfortable', 'large']) {
      await reloadWith(page, { pillLayout: 'row', buttonSize });
      measured[buttonSize] = await layoutMetrics(page);
      await expectNoHorizontalScroll(page);
      expect(await smallTargets(page), buttonSize).toEqual([]);
      const tvBox = await box(page.locator('.tv'));
      const bottom = await box(page.locator('.bottom'));
      const top = await box(page.locator('.top'));
      expect(bottom.y + bottom.height, `${buttonSize}: dentro da tela`).toBeLessThanOrEqual(
        tvBox.y + tvBox.height + 0.5,
      );
      expect(top.y + top.height, `${buttonSize}: sem sobrepor os atalhos`).toBeLessThanOrEqual(
        bottom.y + 0.5,
      );
      expect(measured[buttonSize].scrollOverflow, `${buttonSize}: não rola`).toBeLessThanOrEqual(0);
      await screenshot(
        page,
        `test-results/tv-layout-landscape-row-${buttonSize}-${info.project.name}.png`,
      );
    }
    writeFileSync(
      `test-results/tv-layout-landscape-metrics-${info.project.name}.json`,
      JSON.stringify(measured, null, 2),
    );
  });
});

for (const screen of [
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const) {
  test.describe(`pílulas em fileira em ${screen.name} (${screen.width}x${screen.height})`, () => {
    test.use({ viewport: { width: screen.width, height: screen.height } });

    test('cabe sem rolagem, com alvos de 44 px e os círculos sem estourar', async ({
      page,
    }, info) => {
      await openTv(page, { pillLayout: 'row' });
      await expectNoHorizontalScroll(page);
      await expectNoVerticalScroll(page);
      expect(await smallTargets(page)).toEqual([]);
      const found = await layoutMetrics(page);
      const tvBox = await box(page.locator('.tv'));
      for (const round of found.rounds) {
        expect(round.x).toBeGreaterThanOrEqual(tvBox.x - 0.5);
        expect(round.x + round.width).toBeLessThanOrEqual(tvBox.x + tvBox.width + 0.5);
      }
      await screenshot(page, `test-results/tv-layout-row-${screen.name}-${info.project.name}.png`);
    });
  });
}

/** A convidada com a sessão aberta, direto no controle (o mesmo que o aceite do convite deixa pronto). */
async function openTvAsGuest(page: Page) {
  identity.guests.push({
    id: '00000000-0000-4000-8000-000000000051',
    displayName: GUEST.displayName,
    email: GUEST.email,
    password: GUEST.password,
    createdAt: '2026-10-19T15:00:00Z',
    disabledAt: null,
  });
  identity.role = 'guest';
  identity.loggedIn = true;
  await page.goto('/tv');
  await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
  await emitSse(page, 'tv.state', tv.state);
  await emitSse(page, 'tv.shortcuts', tv.shortcuts);
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeVisible();
  await settle(page);
}

const settingsButton = (page: Page) => header(page).getByRole('link', { name: 'Configurações' });

test.describe('cabeçalho da convidada: o mesmo topo do dono, sem engrenagem', () => {
  test('a seta, os três pontos e o desligar são os mesmos círculos de 44 px; não há botão de configurações', async ({
    page,
  }, info) => {
    await openTvAsGuest(page);
    await expect(settingsButton(page)).toHaveCount(0);
    await expect(header(page).locator('app-gear-icon')).toHaveCount(0);
    const back = header(page).getByRole('link', { name: 'Voltar ao Início' });
    await expect(back).toHaveAttribute('href', '/');

    for (const target of [back, menuButton(page), powerButton(page)]) {
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
    expect(await style(back)).toEqual(await style(menuButton(page)));
    expect(await style(powerButton(page))).toEqual(await style(menuButton(page)));
    await expectTitleCentered(page);

    await screenshot(page, `test-results/tv-header-guest-${info.project.name}.png`);
  });

  test('o nome fica no meio da tela, curto, médio ou longo, com o ponto e o desligar à direita', async ({
    page,
  }, info) => {
    await openTvAsGuest(page);
    for (const [size, name] of [
      ['short', 'TV'],
      ['medium', 'Sala de TV'],
      ['long', LONG_NAME],
    ] as const) {
      await reloadWith(page, { name });
      await expect(header(page).getByRole('heading', { level: 1 })).toHaveText(name);
      await expectTitleCentered(page);
      await expectTitleContained(page);
      await expectNoHorizontalScroll(page);
      expect(await smallTargets(page), name).toEqual([]);
      await screenshot(page, `test-results/tv-header-name-${size}-guest-${info.project.name}.png`);
    }
  });

  test('a seta volta à Início, de onde se chega às Configurações', async ({ page }) => {
    await openTvAsGuest(page);
    await page.getByRole('link', { name: 'Voltar ao Início' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('article[data-module="tv"]')).toBeVisible();
  });

  test('o dono também não tem botão de configurações no controle', async ({ page }) => {
    await openTv(page);
    await expect(backLink(page)).toBeVisible();
    await expect(settingsButton(page)).toHaveCount(0);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`sem violações de acessibilidade e com alvos de 44 px no tema ${scheme}`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await openTvAsGuest(page);
      await expectNoA11yViolations(page);
      expect(await smallTargets(page), 'todos os alvos do topo têm 44 px').toEqual([]);
      await screenshot(page, `test-results/tv-header-guest-${scheme}-${info.project.name}.png`);
    });
  }

  test('em paisagem curta o topo continua inteiro, com o nome no meio e sem rolagem horizontal', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await openTvAsGuest(page);
    await expectTitleCentered(page);
    await expectNoHorizontalScroll(page);
  });
});
