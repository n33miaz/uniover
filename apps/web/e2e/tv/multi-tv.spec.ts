import { join } from 'node:path';
import { Page } from '@playwright/test';
import { GUEST, IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import {
  MockShortcut,
  MockTv,
  TvMock,
  installFakeEventSource,
  mockTvApi,
  sseUrls,
} from './tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints (o orquestrador aponta uma pasta); sem a variável, ficam em `test-results`. */
const SHOTS = process.env['TV_MULTI_SHOTS'] ?? 'test-results';

const ANDROID_CAPS = ['tv.remote', 'tv.kind.android', 'tv.adb'];
// O que o agente de uma Samsung declara: o tipo, a mensagem de teclas e uma capacidade por tecla opcional.
const SAMSUNG_KEYS = [
  'INPUT',
  'INFO',
  'GUIDE',
  'TOOLS',
  'CHANNEL_LIST',
  'EXIT',
  'PLAY',
  'PAUSE',
  'STOP',
  'REWIND',
  'FAST_FORWARD',
  'RED',
  'GREEN',
  'YELLOW',
  'BLUE',
  'SUBTITLE',
  'ASPECT',
  'SLEEP',
  'E_MANUAL',
];
const SAMSUNG_CAPS = [
  'tv.remote',
  'tv.kind.samsung',
  'tv.key.v3',
  ...SAMSUNG_KEYS.map((key) => `tv.key.${key}`),
];

const CASA: MockTv = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Casa',
  isDefault: true,
  agentSlug: 'pc-casa',
  kind: 'android',
  online: true,
  capabilities: ANDROID_CAPS,
  state: {
    power: 'on',
    volume: 22,
    app: null,
    connection: 'hot',
    agentOnline: true,
    updatedAt: '2026-10-19T14:02:00Z',
  },
  shortcuts: [shortcut(1, 'Spotify')],
};
const RAPHAEL: MockTv = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Raphael',
  isDefault: false,
  agentSlug: 'pc-raphael',
  kind: 'samsung',
  online: true,
  capabilities: SAMSUNG_CAPS,
  state: {
    power: 'on',
    volume: 7,
    app: null,
    connection: 'hot',
    agentOnline: true,
    updatedAt: '2026-10-19T14:02:00Z',
  },
  shortcuts: [shortcut(1, 'Netflix')],
};

/** A Samsung como a única TV da conta (então a padrão): abre direto, sem passar pelo seletor. */
const ALONE: MockTv = { ...RAPHAEL, isDefault: true };
/** Com a Casa ao lado (uma TV sozinha não mostra o nome no cabeçalho). */
const withHome = (raphael: MockTv): MockTv[] => [raphael, { ...CASA, isDefault: false }];

function shortcut(position: number, label: string): MockShortcut {
  return {
    id: `00000000-0000-4000-8000-0000000002${String(position).padStart(2, '0')}${label.length}`,
    position,
    package: `exemplo.${label.toLowerCase()}`,
    tvLabel: label,
    customLabel: null,
    enabled: true,
    installed: true,
  };
}

let identity: IdentityMock;
let tv: TvMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  tv = await mockTvApi(context, identity);
  await installFakeEventSource(page);
  identity.loggedIn = true;
});

/** O dono de volta à TV com as TVs do servidor dadas (uma cópia: cada teste muda as suas). */
function serve(list: readonly MockTv[]) {
  tv.tvs = list.map((item) => ({ ...item }));
}

async function openTv(page: Page, title: string) {
  await page.goto('/tv');
  await expect.poll(() => sseUrls(page).then((urls) => urls.length)).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await settle(page);
}

async function useScheme(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
  await settle(page);
}

async function shoot(page: Page, name: string, project: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await useScheme(page, scheme);
    await screenshot(page, join(SHOTS, `${name}-${scheme}-${project}.png`));
  }
}

async function expectSound(page: Page) {
  await expectNoHorizontalScroll(page);
  expect(await smallTargets(page)).toEqual([]);
  for (const scheme of ['light', 'dark'] as const) {
    await useScheme(page, scheme);
    await expectNoA11yViolations(page);
  }
}

const header = (page: Page) => page.locator('.tv > header.head');
const switcherButton = (page: Page) => header(page).locator('h1 button');
const switchDialog = (page: Page) => page.getByRole('dialog', { name: 'Escolher a TV' });
const chip = (page: Page, label: string) => page.locator(`.shortcut[aria-label="${label}"]`);
const menuDialog = (page: Page) => page.getByRole('dialog', { name: 'Mais opções' });

async function pickTv(page: Page, name: string) {
  await switcherButton(page).click();
  await expect(switchDialog(page)).toBeVisible();
  await switchDialog(page)
    .getByRole('button', { name: new RegExp(name) })
    .click();
  await expect(switchDialog(page)).toBeHidden();
}

test.describe('uma TV só', () => {
  test('com uma TV só, comandos e fluxo continuam sem tvId', async ({ page }) => {
    serve([CASA]);
    await openTv(page, 'TV');
    await expect(page.getByRole('button', { name: 'TV, personalizar' })).toBeVisible();
    await expect(header(page).locator('.chevron')).toHaveCount(0);
    expect(await sseUrls(page)).toEqual(['/api/v1/tv/events']);
    await expect(chip(page, 'Spotify')).toBeVisible();
    expect(tv.requests.filter((r) => r.path !== '/layout' && r.tvId !== null)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Teclado', exact: true })).toBeVisible();
  });

  test('com o servidor sem a lista de TVs (404) o app age como sempre', async ({ page }) => {
    tv.tvs = null;
    await openTv(page, 'TV');
    expect(await sseUrls(page)).toEqual(['/api/v1/tv/events']);
    expect(tv.requests.some((r) => r.path === '/tvs')).toBe(true);
    expect(tv.requests.filter((r) => r.path !== '/layout' && r.tvId !== null)).toEqual([]);
  });
});

test.describe('duas TVs', () => {
  test('o título vira o seletor, e a folha lista as TVs com o estado e a TV em uso', async ({
    page,
  }, info) => {
    serve([CASA, { ...RAPHAEL, online: false }]);
    await openTv(page, 'Casa');
    const title = switcherButton(page);
    await expect(title).toHaveAccessibleName('Casa, trocar de TV');
    await expect(title.locator('.chevron')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shoot(page, 'seletor-fechado', info.project.name);

    await title.click();
    const dialog = switchDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('button.ui-row')).toHaveCount(2);
    await expect(dialog.getByRole('button', { name: /Casa/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(dialog.getByRole('button', { name: /Raphael/ })).not.toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(dialog.getByRole('button', { name: /Raphael/ })).toContainText('agente desligado');
    await settle(page);
    await shoot(page, 'seletor-aberto', info.project.name);
    await expectSound(page);
  });

  test('a seta do seletor não desloca o título: o texto fica no centro real da tela, com a seta solta ao lado', async ({
    page,
  }) => {
    serve([CASA, RAPHAEL]);
    await openTv(page, 'Casa');
    const title = switcherButton(page);
    const chevron = title.locator('.chevron');
    await expect(chevron).toBeVisible();
    // A seta sai do fluxo (posição absoluta): é por isso que o texto não se mexe.
    await expect(chevron).toHaveCSS('position', 'absolute');
    const viewport = page.viewportSize()!.width;
    const text = (await title.locator('.title-text').boundingBox())!;
    expect(
      Math.abs(text.x + text.width / 2 - viewport / 2),
      'o centro do texto é o centro da tela',
    ).toBeLessThanOrEqual(1.5);
    // A seta fica logo ao lado do fim do texto, e na mesma altura dele.
    const arrow = (await chevron.boundingBox())!;
    expect(arrow.x, 'a seta depois do texto').toBeGreaterThanOrEqual(text.x + text.width - 1);
    expect(arrow.x - (text.x + text.width), 'e colada nele').toBeLessThanOrEqual(6);
    expect(Math.abs(arrow.y + arrow.height / 2 - (text.y + text.height / 2))).toBeLessThanOrEqual(
      4,
    );
    // E o mesmo centro de quando o título não é um seletor (uma TV só): a seta não muda nada.
    serve([ALONE]);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const alone = (await page.locator('h1 .title-text').boundingBox())!;
    expect(Math.abs(alone.x + alone.width / 2 - viewport / 2)).toBeLessThanOrEqual(1.5);
  });

  test('a folha fecha por Esc e pelo toque fora, e devolve o foco ao título', async ({ page }) => {
    serve([CASA, RAPHAEL]);
    await openTv(page, 'Casa');
    await switcherButton(page).click();
    await expect(switchDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(switchDialog(page)).toBeHidden();
    await expect(switcherButton(page)).toBeFocused();

    await switcherButton(page).click();
    await expect(switchDialog(page)).toBeVisible();
    await page.mouse.click(8, 8);
    await expect(switchDialog(page)).toBeHidden();
  });

  test('trocar de TV não mostra os atalhos da anterior na nova, nem por um instante', async ({
    page,
  }) => {
    serve([CASA, RAPHAEL]);
    await openTv(page, 'Casa');
    await expect(chip(page, 'Spotify')).toBeVisible();

    // A TV nova ainda não respondeu: o que se sabia da anterior já saiu da tela.
    let release!: () => void;
    tv.shortcutsGate = new Promise<void>((resolve) => (release = resolve));
    await pickTv(page, 'Raphael');
    await expect(page.getByRole('heading', { level: 1, name: 'Raphael' })).toBeVisible();
    await expect(chip(page, 'Spotify')).toHaveCount(0);
    await expect(chip(page, 'Netflix')).toHaveCount(0);

    release();
    tv.shortcutsGate = null;
    await expect(chip(page, 'Netflix')).toBeVisible();
    await expect(chip(page, 'Spotify')).toHaveCount(0);
    await expect(page.locator('[aria-label="Volume 7"]').first()).toBeVisible();

    // Os pedidos e o fluxo passam a ser os da TV nova.
    await expect.poll(() => sseUrls(page)).toContain(`/api/v1/tv/events?tvId=${RAPHAEL.id}`);
    expect(
      tv.requests.filter((r) => r.path === '/shortcuts' && r.tvId === RAPHAEL.id).length,
    ).toBeGreaterThan(0);

    // Voltar à primeira mostra só a dela.
    await pickTv(page, 'Casa');
    await expect(chip(page, 'Spotify')).toBeVisible();
    await expect(chip(page, 'Netflix')).toHaveCount(0);
  });

  test('a TV escolhida fica guardada para a próxima vez, e a preferência é de cada TV', async ({
    page,
  }) => {
    serve([CASA, RAPHAEL]);
    await openTv(page, 'Casa');
    await pickTv(page, 'Raphael');
    await expect(page.getByRole('heading', { level: 1, name: 'Raphael' })).toBeVisible();

    // O apelido de uma TV não vale para a outra (as preferências são por conta e por TV).
    await menuDialogOpen(page);
    await menuDialog(page).getByRole('button', { name: 'Personalizar', exact: true }).click();
    const sheet = page.locator('app-tv-customize-sheet dialog');
    await sheet.getByLabel('Nome da TV').fill('Quarto');
    await sheet.getByRole('button', { name: 'Concluir' }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Quarto' })).toBeVisible();
    await expect.poll(() => tv.layouts[RAPHAEL.id]?.['name']).toBe('Quarto');

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Quarto' })).toBeVisible();
    await expect.poll(() => sseUrls(page)).toContain(`/api/v1/tv/events?tvId=${RAPHAEL.id}`);

    await pickTv(page, 'Casa');
    await expect(page.getByRole('heading', { level: 1, name: 'Casa' })).toBeVisible();
  });

  test('convidada ajusta uma TV e volta à base sem alterar a outra', async ({ page }) => {
    const guestId = '00000000-0000-4000-8000-000000000074';
    identity.guests.push({
      id: guestId,
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:tv', 'tv:control'],
    });
    identity.role = 'guest';
    serve([CASA, RAPHAEL]);
    tv.members[CASA.id] = [guestId];
    tv.members[RAPHAEL.id] = [guestId];
    const layout = (name: string) => ({
      name,
      buttonSize: 'comfortable',
      showMedia: true,
      showChannel: true,
      startPage: 'last',
      padSpeed: 'normal',
      pillLayout: 'sides',
      extraKeys: null,
      dismissedSuggestions: [],
    });
    tv.layouts[CASA.id] = layout('Sala');
    tv.layouts[RAPHAEL.id] = layout('Raphael');

    await openTv(page, 'Sala');
    await menuDialogOpen(page);
    await menuDialog(page).getByRole('button', { name: 'Personalizar', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Personalizar' });
    await sheet.getByLabel('Nome da TV').fill('Minha sala');
    await expect(page.getByRole('heading', { level: 1, name: 'Minha sala' })).toBeVisible();
    expect(tv.layouts[CASA.id]?.['name']).toBe('Sala');
    await sheet.getByRole('button', { name: 'Voltar ao padrão da TV' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Sala' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Concluir' }).click();
    await pickTv(page, 'Raphael');
    await expect(page.getByRole('heading', { level: 1, name: 'Raphael' })).toBeVisible();
    expect(
      tv.requests.filter((request) => request.path === '/layout' && request.method === 'PUT'),
    ).toEqual([]);
  });

  test('se a TV guardada sumiu, cai na padrão sem erro', async ({ page }) => {
    serve([CASA, RAPHAEL]);
    await openTv(page, 'Casa');
    await pickTv(page, 'Raphael');
    await expect(page.getByRole('heading', { level: 1, name: 'Raphael' })).toBeVisible();

    // O administrador removeu a TV do Raphael: a lista nova só tem a padrão.
    tv.tvs = tv.tvs!.filter((item) => item.id !== RAPHAEL.id);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
    await expect(chip(page, 'Spotify')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

async function menuDialogOpen(page: Page) {
  await header(page).getByRole('button', { name: 'Mais opções' }).click();
  await expect(menuDialog(page)).toBeVisible();
}

test.describe('capacidades da TV', () => {
  test('uma Samsung não tem teclado nem limpeza, e uma Android tem os dois', async ({
    page,
  }, info) => {
    serve([CASA, RAPHAEL]);
    await openTv(page, 'Casa');
    await expect(page.getByRole('button', { name: 'Teclado', exact: true })).toBeVisible();
    await menuDialogOpen(page);
    await menuDialog(page).getByRole('button', { name: 'Apps da TV', exact: true }).click();
    const apps = page.getByRole('dialog', { name: 'Apps da TV' });
    await expect(apps.getByRole('button', { name: 'Limpar a TV' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(apps).toBeHidden();

    await pickTv(page, 'Raphael');
    await expect(page.getByRole('heading', { level: 1, name: 'Raphael' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Teclado', exact: true })).toHaveCount(0);
    // Registra o buraco que a regra antiga fabricava (oito colunas de meia largura, a segunda fileira de três no meio)
    // para comparar a correção no mesmo aparelho.
    // (Folha de estilo construída pelo script: a política de segurança da página não deixa injetar `<style>`.)
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`
        .round-grid { grid-template-columns: repeat(8, minmax(0, 1fr)); }
        .round-grid > .round:nth-child(n+8) { display: none; }
        .round-grid > .round { grid-column: span 2; }
        .round-grid > .round:nth-child(5) { grid-column: 2 / span 2; }
      `);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      (window as unknown as { oldSheet: CSSStyleSheet }).oldSheet = sheet;
    });
    await screenshot(page, join(SHOTS, 'tv-samsung-before', `${info.project.name}.png`));
    await page.evaluate(() => {
      const holder = window as unknown as { oldSheet: CSSStyleSheet };
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (sheet) => sheet !== holder.oldSheet,
      );
    });

    // Sete botões fixos mais a Fonte: duas fileiras de quatro, sem célula vazia.
    await expect(page.locator('.round-grid .round')).toHaveCount(8);
    await expect(page.getByRole('button', { name: 'Fonte', exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Volume 7' })).toBeVisible();
    const rows = await page.locator('.round-grid .round').evaluateAll((buttons) => {
      const byTop = new Map<number, number[]>();
      for (const button of buttons) {
        const box = button.getBoundingClientRect();
        const top = Math.round(box.top);
        byTop.set(top, [...(byTop.get(top) ?? []), Math.round(box.left)]);
      }
      return [...byTop.values()].map((row) => row.sort((a, b) => a - b));
    });
    expect(rows.map((row) => row.length)).toEqual([4, 4]);
    expect(rows[1]).toEqual(rows[0]);
    await expectNoHorizontalScroll(page);
    await screenshot(page, join(SHOTS, 'tv-samsung-after', `${info.project.name}.png`));

    // Os apps seguem (a Samsung os abre pelo canal dela); o que some é a limpeza.
    await menuDialogOpen(page);
    await menuDialog(page).getByRole('button', { name: 'Apps da TV', exact: true }).click();
    await expect(apps).toBeVisible();
    await expect(apps.getByRole('button', { name: 'Limpar a TV' })).toHaveCount(0);
    await expect(apps.getByRole('button', { name: 'Atualizar lista' })).toBeVisible();
  });

  test('os botões extras: Personalizar escolhe, a grade se completa e o resto fica em Mais botões', async ({
    page,
  }, info) => {
    serve(withHome(ALONE));
    await openTv(page, 'Raphael');
    const grid = page.locator('.round-grid .round');
    await expect(grid).toHaveCount(8);

    await menuDialogOpen(page);
    await menuDialog(page).getByRole('button', { name: 'Personalizar', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Personalizar' });
    await expect(sheet).toBeVisible();
    const chips = sheet.getByRole('group', { name: 'Botões extras' });
    await expect(chips.getByRole('button', { name: 'Fonte', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(chips.getByRole('button', { name: 'Guia', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await chips.scrollIntoViewIfNeeded();
    await screenshot(page, join(SHOTS, 'tv-samsung-personalizar', `${info.project.name}.png`));

    // Escolher o Guia o põe na tela principal, no lugar que a Fonte preenchia sozinha.
    await chips.getByRole('button', { name: 'Guia', exact: true }).click();
    await expect(chips.getByRole('button', { name: 'Guia', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(chips.getByRole('button', { name: 'Fonte', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await sheet.getByRole('button', { name: 'Concluir' }).click();
    await expect(sheet).toBeHidden();
    await expect(grid).toHaveCount(8);
    await expect(
      page.locator('.round-grid').getByRole('button', { name: 'Guia', exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('.round-grid').getByRole('button', { name: 'Fonte', exact: true }),
    ).toHaveCount(0);

    // Tocar no botão manda a tecla.
    await page.locator('.round-grid').getByRole('button', { name: 'Guia', exact: true }).click();
    await expect.poll(() => tv.keysSent()).toContain('GUIDE');

    // O que ficou de fora está em Mais botões.
    await menuDialogOpen(page);
    await menuDialog(page).getByRole('button', { name: 'Mais botões', exact: true }).click();
    const more = page.getByRole('dialog', { name: 'Mais botões' });
    await expect(more).toBeVisible();
    await expect(more.getByRole('button', { name: 'Fonte', exact: true })).toBeVisible();
    await expect(more.getByRole('button', { name: 'Vermelho', exact: true })).toBeVisible();
    await expect(more.getByRole('button', { name: 'Guia', exact: true })).toHaveCount(0);
    await settle(page);
    await screenshot(page, join(SHOTS, 'tv-samsung-mais-botoes', `${info.project.name}.png`));
    await more.getByRole('button', { name: 'Vermelho', exact: true }).click();
    await expect.poll(() => tv.keysSent()).toContain('RED');
    await expectNoHorizontalScroll(page);
  });

  test('a grade fecha sem célula vazia com o agente antigo e com o novo, em qualquer tamanho', async ({
    page,
  }, info) => {
    const oldAgent: MockTv = {
      ...ALONE,
      capabilities: ['transport.keepalive.v1', 'tv.remote', 'tv.kind.samsung'],
      state: { ...ALONE.state!, volume: null },
    };
    const cases = [
      { label: 'novo', tvs: withHome(ALONE), prefs: {} },
      { label: 'novo-grande', tvs: withHome(ALONE), prefs: { buttonSize: 'large' } },
      { label: 'novo-fileira', tvs: withHome(ALONE), prefs: { pillLayout: 'row' } },
      { label: 'antigo', tvs: withHome(oldAgent), prefs: {} },
      { label: 'antigo-grande', tvs: withHome(oldAgent), prefs: { buttonSize: 'large' } },
      { label: 'antigo-fileira', tvs: withHome(oldAgent), prefs: { pillLayout: 'row' } },
      { label: 'antigo-sem-midia', tvs: withHome(oldAgent), prefs: { showMedia: false } },
    ];
    for (const item of cases) {
      serve(item.tvs);
      await openTv(page, 'Raphael');
      await page.evaluate(
        (prefs) =>
          localStorage.setItem(
            `uniover.tv.prefs.v2.${localStorage.getItem('uniover.account-id') ?? ''}`,
            JSON.stringify(prefs),
          ),
        item.prefs,
      );
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'Raphael' })).toBeVisible();
      await settle(page);

      const layout = await page.locator('.round-grid .round').evaluateAll((buttons) => {
        const grid = buttons[0]!.parentElement!;
        const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
        const rows = new Map<number, number>();
        for (const button of buttons) {
          const top = Math.round(button.getBoundingClientRect().top);
          rows.set(top, (rows.get(top) ?? 0) + 1);
        }
        return {
          total: buttons.length,
          perRow: [...rows.values()],
          display: getComputedStyle(grid).display,
          columns,
        };
      });
      // Toda fileira tem o mesmo número de botões: nenhuma célula vazia, nem no meio nem no fim.
      expect(new Set(layout.perRow).size, `${item.label}: ${JSON.stringify(layout)}`).toBe(1);
      await expectNoHorizontalScroll(page);
      await screenshot(
        page,
        join(SHOTS, 'tv-samsung-grade', `${item.label}-${info.project.name}.png`),
      );
    }

    // Os botões que o dono citou estão na tela principal de uma Samsung de agente novo.
    serve(withHome(ALONE));
    await page.evaluate(() =>
      localStorage.removeItem(
        `uniover.tv.prefs.v2.${localStorage.getItem('uniover.account-id') ?? ''}`,
      ),
    );
    await openTv(page, 'Raphael');
    for (const name of [
      'Fonte',
      'Menu',
      'Próximo canal',
      'Canal anterior',
      'Reproduzir ou pausar',
    ]) {
      await expect(page.getByRole('button', { name, exact: true }).first()).toBeVisible();
    }
  });

  test('o volume lido aparece no contador, e sem leitura o contador mostra o alto-falante', async ({
    page,
  }) => {
    serve(withHome(ALONE));
    await openTv(page, 'Raphael');
    await expect(page.getByRole('img', { name: 'Volume 7' })).toBeVisible();
    serve(withHome({ ...ALONE, state: { ...ALONE.state!, volume: null } }));
    await openTv(page, 'Raphael');
    await expect(page.getByRole('img', { name: 'Volume sem leitura' })).toBeVisible();
    await expect(page.locator('.pill.volume .level strong')).toHaveCount(0);
  });

  test('com o agente desligado a TV não perde botões (a API não sabe o que ele faz)', async ({
    page,
  }) => {
    serve([{ ...CASA, online: false, kind: null, capabilities: [] }, RAPHAEL]);
    await openTv(page, 'Casa');
    await expect(page.getByRole('button', { name: 'Teclado', exact: true })).toBeVisible();
  });
});

test.describe('conta que só vê a TV dela', () => {
  test('com uma TV só visível não há seletor, nem tvId, e vê o estado da dela', async ({
    page,
  }) => {
    identity.guests.push({
      id: '00000000-0000-4000-8000-000000000071',
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:tv', 'tv:control', 'tv:launch'],
    });
    identity.role = 'guest';
    serve([CASA, RAPHAEL]);
    tv.members[RAPHAEL.id] = ['00000000-0000-4000-8000-000000000071'];

    await openTv(page, 'TV');
    await expect(header(page).locator('.chevron')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'TV, personalizar' })).toBeVisible();
    expect(await sseUrls(page)).toEqual(['/api/v1/tv/events']);
    // É a TV do Raphael (volume 7, Netflix, sem teclado), não a padrão.
    await expect(page.locator('[aria-label="Volume 7"]').first()).toBeVisible();
    await expect(chip(page, 'Netflix')).toBeVisible();
    await expect(chip(page, 'Spotify')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Teclado', exact: true })).toHaveCount(0);
    expect(tv.requests.filter((r) => r.path !== '/layout' && r.tvId !== null)).toEqual([]);
    expect(tv.denied).toEqual([]);
    await expectSound(page);
  });

  test('uma conta que está em duas TVs escolhe entre as duas, e nunca vê as que não são dela', async ({
    page,
  }) => {
    const OTHER: MockTv = {
      ...RAPHAEL,
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Garagem',
      agentSlug: 'pc-garagem',
    };
    identity.guests.push({
      id: '00000000-0000-4000-8000-000000000072',
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:tv', 'tv:control'],
    });
    identity.role = 'guest';
    serve([CASA, RAPHAEL, OTHER]);
    tv.members[RAPHAEL.id] = ['00000000-0000-4000-8000-000000000072'];
    tv.members[OTHER.id] = ['00000000-0000-4000-8000-000000000072'];

    await openTv(page, 'Garagem');
    await switcherButton(page).click();
    const dialog = switchDialog(page);
    await expect(dialog.locator('button.ui-row')).toHaveCount(2);
    await expect(dialog.getByRole('button', { name: /Casa/ })).toHaveCount(0);
  });

  test('sair e entrar noutra conta sem recarregar a página não leva a lista nem o tvId da anterior', async ({
    page,
  }) => {
    const GUEST_ID = '00000000-0000-4000-8000-000000000073';
    identity.guests.push({
      id: GUEST_ID,
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:tv', 'tv:control'],
    });
    serve([CASA, RAPHAEL]);
    tv.members[RAPHAEL.id] = [GUEST_ID];

    // O dono vê as duas TVs e abre a padrão, com o seletor.
    await openTv(page, 'Casa');
    await expect(switcherButton(page)).toBeVisible();
    // A página não será recarregada daqui até o fim: este marcador some se ela for.
    await page.evaluate(() => ((window as unknown as { __samePage: boolean }).__samePage = true));
    const streamsBefore = (await sseUrls(page)).length;

    // Sai pelo roteador (sem `goto`) e entra como a convidada, que só vê a TV do Raphael.
    await inApp(page, '/ajustes/perfil');
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/entrar/);
    const requestsBefore = tv.requests.length;
    await page.getByLabel('E-mail').fill(GUEST.email);
    await page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page).not.toHaveURL(/\/entrar/);
    await inApp(page, '/tv');

    // É a TV do Raphael (volume 7, Netflix), sem seletor: nada da lista do dono ficou.
    await expect(page.locator('[aria-label="Volume 7"]').first()).toBeVisible();
    await expect(chip(page, 'Netflix')).toBeVisible();
    await expect(header(page).locator('.chevron')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __samePage?: boolean }).__samePage),
    ).toBe(true);
    // Comandos e fluxo não levam o id de uma TV que ela não vê; a base usa o id da TV visível.
    expect(
      tv.requests.slice(requestsBefore).filter((r) => r.path !== '/layout' && r.tvId !== null),
    ).toEqual([]);
    expect(
      (await sseUrls(page)).slice(streamsBefore).filter((url) => url.includes('tvId')),
    ).toEqual([]);
    expect(tv.denied).toEqual([]);
  });
});

/** Vai a outra tela pelo roteador, sem recarregar a página (o `goto` do Playwright a recarrega e apaga a memória do app). */
async function inApp(page: Page, path: string) {
  await page.evaluate((target) => {
    history.pushState(null, '', target);
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  }, path);
}
