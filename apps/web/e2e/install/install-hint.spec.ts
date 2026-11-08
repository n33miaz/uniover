import AxeBuilder from '@axe-core/playwright';
import { Locator, Page } from '@playwright/test';
import { GUEST, IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import {
  HOT_STATE,
  SHORTCUTS,
  emitSse,
  installFakeEventSource,
  mockTvApi,
  sseUrls,
} from '../tv/tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker. E aqui a dica
// do atalho na tela de início fica LIGADA (o padrão dos outros testes é silenciá-la).
//
// `actionTimeout`: o padrão do Playwright é SEM prazo para cliques, prints e esperas de ação; um passo que trava no
// WebKit do runner deixava o teste calado por 90 s (o relatório só dizia "Test timeout"). Com prazo, a falha diz qual passo.
test.use({ serviceWorkers: 'block', installHintSilenced: false, actionTimeout: 20_000 });

// A folha abre sozinha ~3 s depois da tela pronta; quem prova que ela NÃO abriu espera um pouco mais que isso.
const AFTER_DELAY_MS = 3600;
// Onde vão os prints; quem roda pode apontar para outra pasta.
const SHOTS = process.env['INSTALL_HINT_SHOTS'] ?? 'test-results/install-hint';

// Agentes de usuário representativos dos formatos documentados (não são capturas de aparelhos reais).
const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
const IPHONE = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ${WEBKIT}`;
const UA = {
  safari: `${IPHONE} Version/17.5 Mobile/15E148 Safari/604.1`,
  chrome: `${IPHONE} CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1`,
  instagram: `${IPHONE} Mobile/21F90 Instagram 340.0.0.28.101 (iPhone14,5; iOS 17_5; pt_BR; pt-BR; scale=3.00; 1170x2532; 600000000)`,
  android:
    'Mozilla/5.0 (Linux; Android 14; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
};

let identity: IdentityMock;

test.beforeEach(async ({ context, page }) => {
  test.setTimeout(75_000);
  await page.clock.install();
  identity = await mockIdentityApi(context);
  await mockTvApi(context, identity);
});

const sheetOf = (page: Page) => page.getByRole('dialog', { name: 'Atalho na tela de início' });
const rowOf = (page: Page) => page.getByRole('button', { name: /^Adicionar à tela de início/ });

async function signInAsOwner() {
  identity.role = 'owner';
  identity.loggedIn = true;
}

/** A convidada já existe e tem sessão: o app a reconhece pelo refresh, sem passar pelo convite. */
async function signInAsGuest() {
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
}

/**
 * O Chromium entrega o pedido de instalação (`beforeinstallprompt`) uma vez, cedo. Aqui ele é simulado: o script
 * dispara o evento até o app o guardar (o app o guarda chamando `preventDefault`, e `dispatchEvent` devolve falso).
 */
async function simulateInstallPrompt(page: Page) {
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      Object.assign(event, {
        prompt: async () => {
          (window as unknown as { __installPrompted: boolean }).__installPrompted = true;
        },
        userChoice: Promise.resolve({ outcome: 'accepted' }),
      });
      if (!window.dispatchEvent(event)) clearInterval(timer);
    }, 150);
    setTimeout(() => clearInterval(timer), 20_000);
  });
}

/** Faz o app se achar aberto a partir da tela de início (no iOS, `navigator.standalone`). */
async function simulateStandalone(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'standalone', {
      get: () => true,
      configurable: true,
    });
  });
}

/** Simula o bug do WebKit: o PWA está instalado, mas o modo aparece como `fullscreen`. */
async function simulateIosFullscreenPwa(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'standalone', {
      get: () => false,
      configurable: true,
    });
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      query === '(display-mode: fullscreen)'
        ? ({ matches: true, media: query } as unknown as MediaQueryList)
        : original(query);
  });
}

/** O ambiente "de fábrica" de cada projeto: iPhone Safari no `iphone-12`; Android com o pedido nativo no `s23-fe`. */
async function projectDefaultEnvironment(page: Page, project: string) {
  if (project === 's23-fe') await simulateInstallPrompt(page);
}

async function showHome(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Bom dia|Boa tarde|Boa noite/);
}

/** O controle da TV pronto: o fluxo em tempo real (falso) entrega o estado e os atalhos. */
async function settleTv(page: Page) {
  await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
  await emitSse(page, 'tv.state', HOT_STATE);
  await emitSse(page, 'tv.shortcuts', SHORTCUTS);
  await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
}

async function showTv(page: Page) {
  await installFakeEventSource(page);
  await page.goto('/tv');
  await settleTv(page);
}

/**
 * Espera as animações que têm fim acabarem, com teto de 5 s: print e axe só valem com a tela parada. Não usa
 * `animation.finished` nem `requestAnimationFrame` (sem prazo: se o navegador não entrega quadros, o teste ficava
 * pendurado até o limite); consulta o estado a cada 100 ms e, passado o teto, segue em frente.
 */
async function settleAnimations(page: Page) {
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.playState !== 'running' ||
              animation.effect?.getComputedTiming().iterations === Infinity,
          ),
      undefined,
      { polling: 100, timeout: 5000 },
    )
    .catch(() => undefined);
}

/**
 * Troca o esquema de cores e espera o app aplicar (o `color-scheme` da raiz muda com o tema); sem isso o print pode
 * sair no esquema anterior, principalmente no WebKit.
 */
async function useScheme(page: Page, scheme: 'light' | 'dark') {
  // Movimento reduzido junto: o axe e o print medem as cores finais; com a folha ainda entrando (opacidade parcial) o
  // contraste do botão primário saía abaixo do mínimo só no executor lento do WebKit do Linux.
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), {
      timeout: 10_000,
    })
    .toBe(scheme);
  await settleAnimations(page);
}

async function expectNoSeriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

/**
 * Axe estrito (qualquer gravidade, inclusive leve e moderada) só na folha aberta: o fundo da tela, inerte atrás dela,
 * tem as próprias conferências nos outros testes.
 */
async function expectNoA11yViolationsInSheet(page: Page) {
  const { violations } = await new AxeBuilder({ page }).include('dialog[open]').analyze();
  expect(
    violations.map(
      (v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
    ),
  ).toEqual([]);
}

/** Todo controle da folha tem pelo menos 44 px nos dois lados. */
async function expectTargets44(page: Page) {
  const small = await sheetOf(page)
    .locator('button, a[href], input:not([aria-hidden="true"])')
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          const box = element.getBoundingClientRect();
          return {
            name: (element.textContent ?? '').trim().slice(0, 30),
            w: box.width,
            h: box.height,
          };
        })
        .filter((box) => Math.min(box.w, box.h) < 43.5),
    );
  expect(small, 'alvos de toque com menos de 44 px').toEqual([]);
}

/** Um controle avulso (a linha de Ajustes ou de Personalizar) tem pelo menos 44 px nos dois lados. */
async function expectTargets44Of(control: Locator) {
  const box = await control.boundingBox();
  expect(box, 'controle sem caixa na tela').not.toBeNull();
  expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(43.5);
}

/** Tudo o que se pode tocar na tela fora de diálogos: o que a dica NÃO pode aumentar. */
function permanentControls(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      Array.from(
        document.querySelectorAll('button, a[href], input, select, textarea, [tabindex]'),
      ).filter((element) => !element.closest('dialog')).length,
  );
}

async function expectSheetClosed(page: Page) {
  await expect(sheetOf(page)).toHaveCount(0);
}

/** O que o Safari faz depois de 7 dias sem uso (e o modo privado ao fechar): some tudo que o site guardou. */
async function wipeSiteData(page: Page) {
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

/**
 * O que o aparelho guardou de um app (a raiz, por padrão). Depois de a sessão ser confirmada a memória é da conta
 * (`uniover.install-hint.v2.<conta>.<app>`); antes disso, e nas versões antigas, é a chave do aparelho.
 */
async function storedMemory(
  page: Page,
  scope: 'root' | 'tv' | 'treino' = 'root',
): Promise<Record<string, unknown> | null> {
  return page.evaluate((app) => {
    const own = Object.keys(localStorage).find(
      (key) => key.startsWith('uniover.install-hint.v2.') && key.endsWith(`.${app}`),
    );
    const device = app === 'root' ? 'uniover.install-hint.v1' : `uniover.install-hint.v1.${app}`;
    const raw = localStorage.getItem(own ?? device);
    return raw ? JSON.parse(raw) : null;
  }, scope);
}

test.describe('no ambiente de fábrica do projeto', () => {
  test('Android sem pedido nativo ainda orienta a instalação pelo menu', async ({ page }, info) => {
    test.skip(info.project.name !== 's23-fe');
    await signInAsOwner();
    await showHome(page);
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expect(sheet.getByRole('listitem')).toHaveCount(2);
    await expect(sheet).toContainText('Abra o menu do navegador');
    await expect(sheet).toContainText('Escolha instalar ou adicionar à tela inicial');
    await sheet.getByRole('button', { name: 'Agora não' }).click();
    await page.goto('/ajustes/aparencia');
    await expect(rowOf(page)).toBeVisible();
  });

  test('o dono: a folha abre uma vez, uns 3 s depois da tela pronta, e "Agora não" é lembrado', async ({
    page,
  }, info) => {
    const native = info.project.name === 's23-fe';
    await projectDefaultEnvironment(page, info.project.name);
    await signInAsOwner();
    await showHome(page);

    // Nunca durante o carregamento: logo depois da tela pronta ainda não há folha.
    await page.clock.fastForward(1000);
    await expectSheetClosed(page);

    const sheet = sheetOf(page);
    await page.clock.fastForward(AFTER_DELAY_MS - 1000);
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expect(sheet.getByRole('heading', { level: 2 })).toHaveText('Atalho na tela de início');
    await expect(sheet).toContainText('Não ocupa espaço no aparelho: é só um atalho');
    if (native) {
      await expect(sheet.getByRole('button', { name: 'Instalar' })).toBeFocused();
      await expect(sheet.getByRole('listitem')).toHaveCount(0);
    } else {
      await expect(sheet.getByRole('listitem')).toHaveCount(3);
      await expect(sheet.getByRole('button').first()).toBeFocused();
      await expect(sheet.getByRole('button').first()).toHaveText('Agora não');
    }
    await settleAnimations(page);
    await expectNoHorizontalScroll(page);
    await expectTargets44(page);
    // A primeira coisa que a pessoa vê: a folha que abriu sozinha (com "Agora não" e "Não mostrar de novo").
    for (const scheme of ['light', 'dark'] as const) {
      await useScheme(page, scheme);
      await expectNoSeriousViolations(page);
      await expectNoA11yViolationsInSheet(page);
      await screenshot(page, `${SHOTS}/auto-owner-${scheme}-${info.project.name}.png`);
    }
    await useScheme(page, 'light');

    await sheet.getByRole('button', { name: 'Agora não' }).click();
    await expectSheetClosed(page);
    expect(await storedMemory(page)).toEqual({ dismissedAt: expect.any(Number) });

    // Recarregar não mostra de novo (a conferência espera mais que o prazo da folha).
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Bom dia|Boa tarde|Boa noite/);
    await page.clock.fastForward(AFTER_DELAY_MS);
    await expectSheetClosed(page);
  });

  test('Esc vale como "Agora não"; "Não mostrar de novo" fica para sempre, e a linha de Ajustes ainda abre a folha', async ({
    page,
    browserName,
  }, info) => {
    await projectDefaultEnvironment(page, info.project.name);
    await signInAsOwner();
    await showHome(page);

    await expect(sheetOf(page)).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expectSheetClosed(page);
    expect(await storedMemory(page)).toEqual({ dismissedAt: expect.any(Number) });

    // O Safari apagou os dados do site (memória do aparelho e da sessão): a conta lembra o "Agora não" e a folha não volta.
    await expect.poll(() => identity.installHintWrites).toBeGreaterThan(0);
    await wipeSiteData(page);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Bom dia|Boa tarde|Boa noite/);
    await page.clock.fastForward(AFTER_DELAY_MS);
    await expectSheetClosed(page);
    await expect.poll(() => storedMemory(page)).toEqual({ dismissedAt: expect.any(Number) });

    // Uma conta sem nenhuma resposta (e sem memória no aparelho): troca o "Agora não" por "Não mostrar de novo".
    await wipeSiteData(page);
    for (const account of Object.keys(identity.installHints)) delete identity.installHints[account];
    await page.reload();
    await expect(sheetOf(page)).toBeVisible({ timeout: 10_000 });
    await sheetOf(page).getByRole('button', { name: 'Não mostrar de novo' }).click();
    await expectSheetClosed(page);
    // A folha que abre sozinha já gravou o "Agora não" (ver `openAuto`); o "nunca" vem por cima.
    expect(await storedMemory(page)).toEqual({ dismissedAt: expect.any(Number), never: true });

    await page.reload();
    await page.clock.fastForward(AFTER_DELAY_MS);
    await expectSheetClosed(page);

    // A linha permanente continua lá e abre a folha (sem "Não mostrar de novo": a pessoa pediu para ver).
    await page.goto('/ajustes/aparencia');
    await expect(rowOf(page)).toBeVisible();
    await rowOf(page).click();
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible();
    // No Chromium (s23-fe) o modo é nativo: a folha traz também o botão Instalar.
    await expect(sheet.getByRole('button')).toHaveText(
      info.project.name === 's23-fe' ? ['Instalar', 'Fechar'] : ['Fechar'],
    );
    await sheet.getByRole('button', { name: 'Fechar' }).click();
    await expectSheetClosed(page);
    // Fechar devolve o foco à linha que abriu a folha (o WebKit não foca botões ao clicar, então só se confere no Chromium).
    if (browserName === 'chromium') await expect(rowOf(page)).toBeFocused();
  });

  test('a convidada vê a folha uma vez no controle, e o controle não ganha nenhum elemento permanente', async ({
    page,
    context,
  }, info) => {
    await projectDefaultEnvironment(page, info.project.name);
    await signInAsGuest();
    await showTv(page);

    // Sem a folha (antes do prazo) e com ela dispensada, o controle é o mesmo da tela instalada.
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    // O que a convidada vê ao abrir o controle pela primeira vez.
    await settleAnimations(page);
    for (const scheme of ['light', 'dark'] as const) {
      await useScheme(page, scheme);
      await expectNoA11yViolationsInSheet(page);
      await screenshot(page, `${SHOTS}/auto-guest-tv-${scheme}-${info.project.name}.png`);
    }
    await useScheme(page, 'light');
    await sheet.getByRole('button', { name: 'Agora não' }).click();
    await expectSheetClosed(page);
    const withHint = await permanentControls(page);

    // Recarregar o controle não traz a folha de volta (a conferência espera mais que o prazo dela).
    await page.reload();
    await settleTv(page);
    await page.clock.fastForward(AFTER_DELAY_MS);
    await expectSheetClosed(page);
    expect(await permanentControls(page)).toBe(withHint);

    const installed = await context.newPage();
    await simulateStandalone(installed);
    await showTv(installed);
    await installed.clock.fastForward(AFTER_DELAY_MS);
    await expect(sheetOf(installed)).toHaveCount(0);
    expect(withHint).toBe(await permanentControls(installed));
    await installed.close();

    // O endereço do manifest (`/tv/`, com barra) cai no controle, e a convidada não vai a lugar nenhum além dele.
    await page.goto('/tv/');
    await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
    await expect(page).toHaveURL(/\/tv\/?$/);
    // Onde o app para de fato (o roteador pode tirar a barra final): relevante para o escopo `/tv/` do manifest.
    console.log(`[${info.project.name}] goto('/tv/') terminou em ${new URL(page.url()).pathname}`);
  });

  test('em Personalizar há uma linha que abre a folha por cima, sem fechar Personalizar, e o foco volta a ela', async ({
    page,
  }, info) => {
    await projectDefaultEnvironment(page, info.project.name);
    await signInAsGuest();
    await showTv(page);
    await expect(sheetOf(page)).toBeVisible({ timeout: 10_000 });
    await sheetOf(page).getByRole('button', { name: 'Agora não' }).click();
    await expectSheetClosed(page);

    await page
      .locator('header.head')
      .getByRole('button', { name: /, personalizar$/ })
      .click();
    const customize = page.getByRole('dialog', { name: 'Personalizar' });
    await expect(customize).toBeVisible();
    const row = customize.getByRole('button', { name: /^Adicionar à tela de início/ });
    await expect(row).toBeVisible();
    await expect(customize.locator('app-install-hint-row')).toHaveCount(1);
    await row.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await expectTargets44Of(row);
    await settleAnimations(page);
    for (const scheme of ['light', 'dark'] as const) {
      await useScheme(page, scheme);
      await screenshot(page, `${SHOTS}/personalizar-row-${scheme}-${info.project.name}.png`);
    }
    await useScheme(page, 'light');

    await row.click();
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button')).toContainText(['Fechar']);
    await page.keyboard.press('Escape');
    await expectSheetClosed(page);

    // Personalizar continua aberta e usável, e o foco voltou para dentro dela.
    await expect(customize).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest('dialog')?.getAttribute('aria-labelledby') ?? null,
        ),
      )
      .toBe('tv-custom-title');
    await customize.getByLabel('Nome da TV').fill('Sala');
    await expect(customize.getByLabel('Nome da TV')).toHaveValue('Sala');
    await customize.getByRole('button', { name: 'Concluir' }).click();
    await expect(customize).toHaveCount(0);
  });

  test('com Personalizar aberta a folha automática espera, e abre depois que ela fecha', async ({
    page,
  }, info) => {
    await projectDefaultEnvironment(page, info.project.name);
    await signInAsGuest();
    await showTv(page);
    await page
      .locator('header.head')
      .getByRole('button', { name: /, personalizar$/ })
      .click();
    const customize = page.getByRole('dialog', { name: 'Personalizar' });
    await expect(customize).toBeVisible();

    await page.clock.fastForward(AFTER_DELAY_MS);
    await expectSheetClosed(page);
    await expect(customize).toBeVisible();

    await customize.getByRole('button', { name: 'Concluir' }).click();
    await expect(customize).toHaveCount(0);
    await expect(sheetOf(page)).toBeVisible({ timeout: 10_000 });
  });

  test('janela instalada confirma a raiz e ainda oferece o atalho próprio da TV', async ({
    page,
  }, info) => {
    await projectDefaultEnvironment(page, info.project.name);
    await simulateStandalone(page);
    await signInAsOwner();
    await page.goto('/?uniover_app=root');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Bom dia|Boa tarde|Boa noite/);
    await page.clock.fastForward(AFTER_DELAY_MS);
    await expectSheetClosed(page);

    await page.goto('/ajustes/aparencia');
    await expect(page.getByRole('heading', { level: 1, name: 'Aparência' })).toBeVisible();
    await expect(rowOf(page)).toHaveCount(0);

    await showTv(page);
    await page
      .locator('header.head')
      .getByRole('button', { name: /, personalizar$/ })
      .click();
    const customize = page.getByRole('dialog', { name: 'Personalizar' });
    await expect(customize).toBeVisible();
    await expect(
      customize.getByRole('button', { name: /^Adicionar à tela de início/ }),
    ).toBeVisible();
  });

  test('no PWA iOS que o WebKit reporta como fullscreen, a dica não reaparece', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'iphone-12', 'simulação do comportamento do WebKit no iPhone');
    await simulateIosFullscreenPwa(page);
    await signInAsOwner();
    await page.goto('/treino/');
    await expect(page.getByRole('heading', { level: 1, name: 'Treino' })).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          [
            (navigator as Navigator & { standalone?: boolean }).standalone,
            window.matchMedia('(display-mode: fullscreen)').matches,
          ] as const,
      ),
    ).toEqual([false, true]);
    await page.clock.fastForward(AFTER_DELAY_MS);
    await expectSheetClosed(page);
  });
});

/**
 * Um modo por vez, com o agente de usuário certo (vale nos dois projetos). Cada modo roda em dois testes, claro e
 * escuro, e cada um faz só o que precisa: abre a folha pela linha de Ajustes, confere, passa o axe e tira o print.
 * Testes pequenos: no WebKit do runner Linux print e axe levam várias vezes o tempo do Windows.
 */
const MODES = [
  { name: 'ios-safari', ua: UA.safari, native: false, buttons: ['Fechar'] },
  { name: 'ios-chrome', ua: UA.chrome, native: false, buttons: ['Fechar'] },
  { name: 'ios-in-app', ua: UA.instagram, native: false, buttons: ['Copiar endereço', 'Fechar'] },
  { name: 'native', ua: UA.android, native: true, buttons: ['Instalar', 'Fechar'] },
] as const;

for (const mode of MODES) {
  test.describe(`modo ${mode.name}`, () => {
    test.use({ userAgent: mode.ua });

    for (const scheme of ['light', 'dark'] as const) {
      test(`a linha de Ajustes abre a folha deste modo: conteúdo, alvos, axe e print (${scheme})`, async ({
        page,
      }, info) => {
        if (mode.native) await simulateInstallPrompt(page);
        await signInAsOwner();
        await page.goto('/ajustes/aparencia');
        await expect(rowOf(page)).toBeVisible();
        await expect(page.locator('app-install-hint-row .ui-tile')).toBeVisible();
        // A linha tem 44 px ou mais nos dois lados (sem rolar a tela: o clique abaixo já leva a linha à vista).
        await expectTargets44Of(rowOf(page));
        await rowOf(page).click();

        const sheet = sheetOf(page);
        await expect(sheet).toBeVisible();
        // Aberta pela pessoa: sem "Agora não" nem "Não mostrar de novo".
        await expect(sheet.getByRole('button')).toHaveText(mode.buttons);
        await useScheme(page, scheme);
        await expectNoHorizontalScroll(page);
        await expectTargets44(page);

        if (scheme === 'light') {
          const items = sheet.getByRole('listitem');
          const titles = sheet.locator('.step-title');
          if (mode.name === 'ios-in-app') {
            await expect(items).toHaveCount(4);
            await expect(titles.first()).toHaveText('Abra este endereço no Safari');
            await expect(sheet.getByRole('button', { name: 'Copiar endereço' })).toBeVisible();
          } else if (!mode.native) {
            await expect(items).toHaveCount(3);
            await expect(titles.first()).toHaveText('Toque em Compartilhar');
          }
          if (mode.name === 'ios-chrome') {
            await expect(sheet).toContainText('No Chrome e no Edge ele fica na barra de endereço');
          }
          if (mode.name === 'ios-safari' || mode.name === 'ios-in-app') {
            await expect(sheet).toContainText('Se você abriu pelo WhatsApp');
          }
        }

        await expectNoSeriousViolations(page);
        await expectNoA11yViolationsInSheet(page);
        await screenshot(page, `${SHOTS}/${mode.name}-${scheme}-${info.project.name}.png`);
      });
    }
  });
}

test.describe('modo native: o botão Instalar', () => {
  test.use({ userAgent: UA.android });

  test('a folha automática mostra Instalar; tocar chama o pedido do navegador e fecha a folha', async ({
    page,
  }, info) => {
    await simulateInstallPrompt(page);
    await signInAsOwner();
    await showHome(page);
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expect(sheet.getByRole('button')).toHaveText([
      'Instalar',
      'Agora não',
      'Não mostrar de novo',
    ]);
    await expect(sheet.getByRole('button', { name: 'Instalar' })).toBeFocused();
    await settleAnimations(page);
    for (const scheme of ['light', 'dark'] as const) {
      await useScheme(page, scheme);
      await screenshot(page, `${SHOTS}/native-auto-${scheme}-${info.project.name}.png`);
    }

    await sheet.getByRole('button', { name: 'Instalar' }).click();
    await expectSheetClosed(page);
    expect(
      await page.evaluate(
        () => (window as unknown as { __installPrompted?: boolean }).__installPrompted,
      ),
    ).toBe(true);
    // Aceito: o pedido do navegador valeu uma vez e a linha de Configurações some. A navegação é por dentro do app: recarregar
    // a página faria o script de teste disparar o pedido de novo, o que um navegador real não faz depois de instalar.
    await page.getByRole('link', { name: 'Configurações', exact: true }).click();
    await page.getByRole('link', { name: /^Aparência/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Aparência' })).toBeVisible();
    await expect(rowOf(page)).toHaveCount(0);
  });
});

test.describe('modo ios-in-app: copiar o endereço', () => {
  test.use({ userAgent: UA.instagram });

  test('"Copiar endereço" confirma em uma região de status e copia o endereço sem busca', async ({
    page,
    context,
    browserName,
  }, info) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await signInAsOwner();
    await page.goto('/ajustes/aparencia');
    await rowOf(page).click();
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Copiar endereço' }).click();

    const status = sheet.getByRole('status');
    // Onde a Clipboard API é recusada o app tenta copiar por seleção; se nada copiar, mostra o endereço na mão.
    await expect(status).toHaveText(/Endereço copiado|Toque e segure/);
    if (browserName === 'chromium') {
      await expect(status).toContainText('Endereço copiado');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        new URL('/ajustes/aparencia', page.url()).href,
      );
    }
    await settleAnimations(page);
    await screenshot(page, `${SHOTS}/ios-in-app-copied-${info.project.name}.png`);
  });
});

test.describe('cada módulo é um app: a memória e o pedido de instalação são por escopo', () => {
  test.use({ userAgent: UA.android });

  const trainingHeading = (page: Page) => page.getByRole('heading', { level: 1, name: 'Treino' });

  /** Como `simulateInstallPrompt`, mas lembra (na sessão, que sobrevive à troca de página) em que endereço o pedido foi usado. */
  async function simulateRecordingPrompt(page: Page) {
    await page.addInitScript(() => {
      const timer = setInterval(() => {
        const event = new Event('beforeinstallprompt', { cancelable: true });
        Object.assign(event, {
          prompt: async () => {
            const used: string[] = JSON.parse(sessionStorage.getItem('promptUsedAt') ?? '[]');
            used.push(location.pathname);
            sessionStorage.setItem('promptUsedAt', JSON.stringify(used));
          },
          userChoice: Promise.resolve({ outcome: 'accepted' }),
        });
        if (!window.dispatchEvent(event)) clearInterval(timer);
      }, 150);
      setTimeout(() => clearInterval(timer), 20_000);
    });
  }

  test('o UniOver geral instalado (e "nunca") não silencia a dica do Treino', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'uniover.install-hint.v1',
        JSON.stringify({ installed: true, never: true }),
      );
    });
    await simulateInstallPrompt(page);
    await signInAsOwner();
    await page.goto('/treino');
    await expect(trainingHeading(page)).toBeVisible();
    await expect(sheetOf(page)).toBeVisible({ timeout: 10_000 });
    await sheetOf(page).getByRole('button', { name: 'Agora não' }).click();
    await expectSheetClosed(page);
    // O "Agora não" do Treino fica na chave do Treino; a da raiz continua como estava.
    expect(await storedMemory(page, 'treino')).toEqual({ dismissedAt: expect.any(Number) });
    expect(await storedMemory(page)).toEqual({ installed: true, never: true });
  });

  test('Treino aberto dentro do app geral no Android não abre a folha sozinha (dentro do app instalado nunca)', async ({
    page,
  }) => {
    await simulateStandalone(page);
    await page.addInitScript(() => {
      localStorage.setItem('uniover.install-hint.v1.treino', JSON.stringify({ installed: true }));
    });
    await signInAsOwner();
    await page.goto('/?uniover_app=root');
    await page.getByRole('link', { name: 'Ver treino' }).click();
    await expect(trainingHeading(page)).toBeVisible();
    await page.clock.fastForward(AFTER_DELAY_MS);
    await expectSheetClosed(page);
  });

  test('pedir para instalar a TV num documento carregado na raiz faz carga completa em /tv/ e usa o pedido da TV', async ({
    page,
  }) => {
    await simulateRecordingPrompt(page);
    await installFakeEventSource(page);
    await signInAsOwner();
    await showHome(page);
    await sheetOf(page).getByRole('button', { name: 'Agora não' }).click({ timeout: 10_000 });
    await expectSheetClosed(page);

    // Navegação por dentro do app até a TV: continua o mesmo documento (sem recarregar). A folha automática já foi
    // mostrada nesta sessão e não repete por app: o pedido da TV vem da linha de Personalizar, que a pessoa toca.
    await page.evaluate(
      () => ((window as unknown as { sameDocument: boolean }).sameDocument = true),
    );
    await page.getByRole('link', { name: 'Abrir controle' }).first().click();
    await settleTv(page);
    expect(
      await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument),
    ).toBe(true);
    await page.clock.fastForward(AFTER_DELAY_MS);
    await expectSheetClosed(page);
    await page
      .locator('header.head')
      .getByRole('button', { name: /, personalizar$/ })
      .click();
    await page
      .getByRole('dialog', { name: 'Personalizar' })
      .getByRole('button', { name: /^Adicionar à tela de início/ })
      .click();

    // O pedido guardado ainda é o da raiz: instalar a TV recarrega a página inteira no escopo dela.
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Instalar' }).click();

    // Carga completa: o documento mudou, o marcador saiu do endereço e a folha reabre com o pedido da TV.
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument),
      )
      .toBeUndefined();
    await expect(page).toHaveURL(/\/tv\/?$/);
    expect(new URL(page.url()).search).toBe('');
    await expect(page.locator('head link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/tv/manifest.webmanifest',
    );
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await sheet.getByRole('button', { name: 'Instalar' }).click();
    await expectSheetClosed(page);
    // O pedido do navegador só foi usado depois da carga em /tv/.
    expect(
      await page.evaluate(() => JSON.parse(sessionStorage.getItem('promptUsedAt') ?? '[]')),
    ).toEqual([expect.stringMatching(/^\/tv\/?$/)]);
  });

  test('no app do Treino já instalado a folha nunca abre sozinha, mesmo com a memória vazia', async ({
    page,
  }) => {
    await simulateStandalone(page);
    await signInAsOwner();
    await page.goto('/treino/?uniover_app=treino');
    await expect(trainingHeading(page)).toBeVisible();
    await page.clock.fastForward(AFTER_DELAY_MS);
    await expectSheetClosed(page);
  });
});

/** Faz a janela se achar em `display-mode: standalone` (o padrão), sem `navigator.standalone`: o outro sinal de app instalado. */
async function simulateDisplayModeStandalone(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'standalone', {
      get: () => false,
      configurable: true,
    });
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      query === '(display-mode: standalone)'
        ? ({
            matches: true,
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          } as unknown as MediaQueryList)
        : original(query);
  });
}

/**
 * O relato da Alice (iPhone, app na tela de início havia muito tempo, respondeu várias vezes): a dica não pode voltar para
 * quem já instalou nem para quem já respondeu, nem depois de o Safari apagar os dados do site, atualizar a conta ou recarregar.
 */
test.describe('iPhone: quem já instalou ou já respondeu não é perguntado de novo', () => {
  test.beforeEach(async ({}, info) => {
    test.skip(
      info.project.name !== 'iphone-12',
      'o relato é do iPhone (Safari e app da tela de início)',
    );
  });

  const HOME = /Bom dia|Boa tarde|Boa noite/;
  const homeReady = (page: Page) =>
    expect(page.getByRole('heading', { level: 1 })).toHaveText(HOME);

  test.describe('dentro do app instalado', () => {
    for (const [name, simulate] of [
      ['navigator.standalone', simulateStandalone],
      ['display-mode: standalone', simulateDisplayModeStandalone],
    ] as const) {
      test(`(${name}) nunca abre: nem na carga, nem depois de recarregar, nem ao renovar a sessão`, async ({
        page,
      }) => {
        await simulate(page);
        await signInAsOwner();
        await page.goto('/');
        await homeReady(page);
        await page.clock.fastForward(AFTER_DELAY_MS * 3);
        await expectSheetClosed(page);

        // O app foi reaberto várias vezes (o iOS o encerra em segundo plano).
        for (let i = 0; i < 3; i++) {
          await page.reload();
          await homeReady(page);
          await page.clock.fastForward(AFTER_DELAY_MS * 3);
          await expectSheetClosed(page);
        }

        // "Atualizar a conta": o token vence e o app renova a sessão sozinho; a folha não reaparece por isso.
        const tokensBefore = identity.issuedTokens.length;
        await page.clock.fastForward(11 * 60 * 1000);
        await expect.poll(() => identity.issuedTokens.length).toBeGreaterThan(tokensBefore);
        await page.clock.fastForward(AFTER_DELAY_MS * 3);
        await expectSheetClosed(page);
        await homeReady(page);
      });
    }

    test('o atalho do UniOver geral aberto em /treino e na TV (outros apps para o navegador) não abre a folha sozinha', async ({
      page,
    }) => {
      await simulateStandalone(page);
      await signInAsOwner();
      await page.goto('/?uniover_app=root');
      await homeReady(page);
      await page.getByRole('link', { name: 'Ver treino' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Treino' })).toBeVisible();
      await page.clock.fastForward(AFTER_DELAY_MS * 3);
      await expectSheetClosed(page);

      await installFakeEventSource(page);
      await page.goto('/tv');
      await settleTv(page);
      await page.clock.fastForward(AFTER_DELAY_MS * 3);
      await expectSheetClosed(page);
    });

    test('grava na conta que o app está instalado: o Safari, com os dados apagados, não pergunta', async ({
      context,
      page,
    }) => {
      await simulateStandalone(page);
      await signInAsOwner();
      await page.goto('/');
      await homeReady(page);
      await expect
        .poll(() => Object.values(identity.installHints).map((hints) => hints['root']))
        .toEqual([{ installed: true }]);
      await page.close();

      // A mesma conta, agora no Safari (armazenamento separado: o do atalho não chega até ele).
      const safari = await context.newPage();
      await safari.clock.install();
      await safari.goto('/');
      await homeReady(safari);
      await wipeSiteData(safari);
      await safari.reload();
      await homeReady(safari);
      await safari.clock.fastForward(AFTER_DELAY_MS * 3);
      await expect(sheetOf(safari)).toHaveCount(0);
    });
  });

  test.describe('no Safari', () => {
    test('a folha que abriu e foi ignorada não volta ao recarregar, nem na sessão, nem com os dados apagados', async ({
      page,
    }) => {
      await signInAsOwner();
      await showHome(page);
      await expect(sheetOf(page)).toBeVisible({ timeout: 10_000 });
      // Sem responder: o iOS mata a página ou a atualização a recarrega com a folha aberta.
      await page.reload();
      await homeReady(page);
      await page.clock.fastForward(AFTER_DELAY_MS * 3);
      await expectSheetClosed(page);

      // O Safari apaga o que o site guardou (7 dias sem uso): só a conta se lembra.
      await expect.poll(() => identity.installHintWrites).toBeGreaterThan(0);
      await wipeSiteData(page);
      await page.reload();
      await homeReady(page);
      await page.clock.fastForward(AFTER_DELAY_MS * 3);
      await expectSheetClosed(page);
    });

    test('"Agora não" vale 30 dias: a conta o repassa, e só depois disso a folha volta uma vez', async ({
      page,
    }) => {
      await signInAsOwner();
      await showHome(page);
      await expect(sheetOf(page)).toBeVisible({ timeout: 10_000 });
      await sheetOf(page).getByRole('button', { name: 'Agora não' }).click();
      await expectSheetClosed(page);
      await expect.poll(() => identity.installHintWrites).toBeGreaterThan(0);

      // 29 dias depois, com os dados do site apagados: ainda não.
      await jumpDays(page, 29);
      await wipeSiteData(page);
      await page.reload();
      await homeReady(page);
      await page.clock.fastForward(AFTER_DELAY_MS * 3);
      await expectSheetClosed(page);

      // Passados os 30 dias, volta uma vez (um lembrete gentil) e não mais nessa sessão.
      await jumpDays(page, 2);
      await wipeSiteData(page);
      await page.reload();
      await homeReady(page);
      await expect(sheetOf(page)).toBeVisible({ timeout: 10_000 });
      await sheetOf(page).getByRole('button', { name: 'Agora não' }).click();
      await page.reload();
      await homeReady(page);
      await page.clock.fastForward(AFTER_DELAY_MS * 3);
      await expectSheetClosed(page);
    });

    test('"Já instalei" fica para sempre, em qualquer tempo e depois de apagar os dados do site', async ({
      page,
    }) => {
      await signInAsOwner();
      await showHome(page);
      await expect(sheetOf(page)).toBeVisible({ timeout: 10_000 });
      await sheetOf(page).getByRole('button', { name: 'Já instalei' }).click();
      await expectSheetClosed(page);
      await expect.poll(() => identity.installHintWrites).toBeGreaterThan(0);

      await jumpDays(page, 400);
      await wipeSiteData(page);
      await page.reload();
      await homeReady(page);
      await page.clock.fastForward(AFTER_DELAY_MS * 3);
      await expectSheetClosed(page);
    });
  });
});

/** Avança o relógio da página por dias (o `fastForward` do Playwright não aceita mais que ~24 dias de uma vez). */
async function jumpDays(page: Page, days: number) {
  const now = await page.evaluate(() => Date.now());
  await page.clock.setSystemTime(now + days * 24 * 60 * 60 * 1000);
}
