import AxeBuilder from '@axe-core/playwright';
import { Locator, Page } from '@playwright/test';
import {
  expect,
  expectNoHorizontalScroll,
  screenshot,
  test,
  waitForServiceWorkerControl,
} from './fixtures';
import { settle } from './screens/screen-helpers';

const agentIndicator = (page: Page) => page.locator('.agent-status');
const blocks = (page: Page) => page.locator('article.card');
// TV e Treino, que já têm tela, e os seis planejados, que aparecem como "Em breve".
const PLANNED = [
  'Saúde e Eventos',
  'Monitor dos Serviços',
  'Rede da Casa',
  'Backup de Fotos',
  'Avisos',
  'Controle do PC',
];
const MODULE_COUNT = 2 + PLANNED.length;
const status = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });

async function expectNoSeriousA11yViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

test.describe('início e navegação', () => {
  test('mostra a bolinha e os blocos, entra em /tv e volta pelo Início', async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Bom dia|Boa tarde|Boa noite/);
    await expect(agentIndicator(page)).toHaveCount(0);
    await expect(blocks(page)).toHaveCount(MODULE_COUNT);
    await expect(page.getByRole('navigation', { name: 'Abas do módulo' })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await screenshot(page, `test-results/home-${info.project.name}.png`);

    await page.getByRole('link', { name: 'TV: Abrir controle' }).click();
    await expect(page).toHaveURL(/\/tv$/);
    await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
    // A TV é uma tela só: não há barra de abas em /tv.
    await expect(page.getByRole('navigation', { name: 'Abas do módulo' })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await screenshot(page, `test-results/tv-${info.project.name}.png`);

    // A TV tem o próprio cabeçalho (e o próprio botão de voltar); a seta da casca é testada nos Ajustes.
    await page.getByRole('link', { name: /Início/ }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(blocks(page)).toHaveCount(MODULE_COUNT);
  });

  test('módulo em breve é só um cartão calmo: sem link, sem botão, sem foco', async ({ page }) => {
    await page.goto('/');
    await expect(blocks(page)).toHaveCount(MODULE_COUNT);
    const planned = page.locator('article.card.planned');
    await expect(planned.locator('h3')).toHaveText(PLANNED);
    await expect(planned.locator('a, button, [tabindex]')).toHaveCount(0);
    // O rótulo fica embaixo do nome, dentro do cartão, e o cartão é vazado com borda tracejada.
    await expect(planned.locator('app-home-soon-badge')).toHaveText(PLANNED.map(() => 'Em Breve'));
    await expect(planned.locator('h3 + app-home-soon-badge')).toHaveCount(PLANNED.length);
    await expect(page.locator('article .badges')).toHaveCount(0);
    await expect(page.locator('article .desc')).toHaveCount(0);
    for (const card of await planned.all()) {
      await expect(card).toHaveCSS('border-top-style', 'dashed');
      await expect(card).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }
    await expect(page.locator('article[data-module="tv"]')).toHaveCSS('border-top-style', 'solid');
    // Só TV e Treino levam a algum lugar.
    await expect(page.locator('article.card a')).toHaveCount(2);

    // Passando pela tela inteira com o teclado, o foco nunca para dentro de um cartão planejado.
    const stops: string[] = [];
    for (let step = 0; step < 24; step += 1) {
      await page.keyboard.press('Tab');
      stops.push(
        await page.evaluate(
          () => document.activeElement?.closest('article')?.getAttribute('data-module') ?? '',
        ),
      );
    }
    expect(stops.filter((id) => id && !['tv', 'training'].includes(id))).toEqual([]);
  });

  test('TV e Treino ficam lado a lado, no mesmo tamanho, mesmo com um tamanho largo salvo', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('uniover.account-id', 'u1');
      localStorage.setItem(
        'uniover.home.widgets.v1.u1',
        JSON.stringify([
          { id: 'training', size: 'wide', enabled: true },
          { id: 'tv', size: 'small', enabled: true },
        ]),
      );
    });
    await page.goto('/');
    await expect(blocks(page)).toHaveCount(MODULE_COUNT);
    await settle(page); // fim da entrada em cascata dos cartões
    const training = (await page.locator('article[data-module="training"]').boundingBox())!;
    const tv = (await page.locator('article[data-module="tv"]').boundingBox())!;
    expect(Math.abs(training.y - tv.y)).toBeLessThan(1);
    expect(training.width).toBeCloseTo(tv.width, 1);
    expect(training.height).toBeCloseTo(tv.height, 1);
    expect(training.x).not.toBeCloseTo(tv.x, 0);
  });

  test('centraliza o último cartão ímpar do dono sem mudar sua largura', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('uniover.account-id', 'u1'));
    await page.goto('/');
    await page.getByRole('button', { name: 'Editar', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Personalizar' });
    await sheet.locator('li', { hasText: 'Controle do PC' }).getByRole('switch').uncheck();
    await sheet.getByRole('button', { name: 'Concluir', exact: true }).click();

    const cards = blocks(page);
    await expect(cards).toHaveCount(MODULE_COUNT - 1);
    const grid = (await page.locator('.grid').boundingBox())!;
    const first = (await cards.first().boundingBox())!;
    const last = (await cards.last().boundingBox())!;
    expect(last.width).toBeCloseTo(first.width, 1);
    expect(Math.abs(last.x + last.width / 2 - (grid.x + grid.width / 2))).toBeLessThan(1);
  });

  test('Personalizar abre a folha, não deixa atalhos antigos na Início e fecha com Esc', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.shortcuts')).toHaveCount(0);
    await page.getByRole('button', { name: 'Editar', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Personalizar' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Voltar ao Padrão' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });

  test('segue o tema escuro do sistema', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('remove a seleção e o realce azul da interface sem bloquear campos de texto', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const styles = await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'text';
      const textarea = document.createElement('textarea');
      const editable = document.createElement('div');
      editable.setAttribute('contenteditable', 'true');
      const copyable = document.createElement('pre');
      copyable.className = 'ui-selectable';
      copyable.textContent = 'registro';
      const copyableChild = document.createElement('span');
      copyable.append(copyableChild);
      document.body.append(input, textarea, editable, copyable);

      // Nem todo motor devolve o realce do toque no estilo calculado (o WebKit de bancada não devolve): sem ele, lê a
      // regra da folha de estilo que vale para o elemento.
      const tapHighlight = (element: Element): string => {
        const computed = getComputedStyle(element);
        const direct =
          (computed as unknown as { webkitTapHighlightColor?: string }).webkitTapHighlightColor ||
          computed.getPropertyValue('-webkit-tap-highlight-color');
        if (direct) return direct;
        for (const sheet of Array.from(document.styleSheets)) {
          for (const rule of Array.from(sheet.cssRules)) {
            if (!(rule instanceof CSSStyleRule) || !element.matches(rule.selectorText)) continue;
            const value = rule.style.getPropertyValue('-webkit-tap-highlight-color');
            if (value) return value;
          }
        }
        return '';
      };
      const read = (element: Element) => {
        const computed = getComputedStyle(element);
        return {
          userSelect: computed.userSelect,
          webkitUserSelect: computed.getPropertyValue('-webkit-user-select'),
          tapHighlight: tapHighlight(element),
        };
      };

      const bodyTouchCallout = getComputedStyle(document.body).getPropertyValue(
        '-webkit-touch-callout',
      );
      const result = {
        text: read(document.querySelector('h1')!),
        button: read(document.querySelector('button')!),
        link: read(document.querySelector('a')!),
        input: read(input),
        textarea: read(textarea),
        editable: read(editable),
        copyable: read(copyable),
        copyableChild: read(copyableChild),
        bodyTouchCallout,
        // O WebKit de bancada do Playwright não conhece a propriedade (só o Safari do aparelho): nele não há o que medir.
        tapHighlightKnown: CSS.supports('-webkit-tap-highlight-color', 'transparent'),
      };
      input.remove();
      textarea.remove();
      editable.remove();
      copyable.remove();
      return result;
    });

    for (const blocked of [styles.text, styles.button, styles.link]) {
      expect(blocked).toMatchObject({ userSelect: 'none', webkitUserSelect: 'none' });
    }
    // Só campos de digitação e o texto marcado para copiar aceitam seleção.
    for (const allowed of [
      styles.input,
      styles.textarea,
      styles.editable,
      styles.copyable,
      styles.copyableChild,
    ]) {
      expect(allowed).toMatchObject({ userSelect: 'text', webkitUserSelect: 'text' });
    }
    // O realce azul do toque some em toda a interface (transparente: o navegador devolve rgba com alfa 0).
    for (const element of styles.tapHighlightKnown
      ? [styles.text, styles.button, styles.link, styles.input]
      : []) {
      expect(element.tapHighlight).toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
    }
    if (styles.bodyTouchCallout) {
      expect(styles.bodyTouchCallout).toBe('none');
    }
  });

  test('o toque duplo ou longo não seleciona texto fora do campo, e dentro dele seleciona', async ({
    page,
  }) => {
    await page.goto('/');
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toBeVisible();
    await heading.click({ clickCount: 3 });
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');

    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'campo-de-teste';
      input.value = 'texto do campo';
      document.body.append(input);
    });
    await page.locator('#campo-de-teste').click({ clickCount: 3 });
    expect(
      await page.evaluate(() => {
        const field = document.querySelector<HTMLInputElement>('#campo-de-teste')!;
        return (field.selectionEnd ?? 0) - (field.selectionStart ?? 0);
      }),
    ).toBeGreaterThan(0);
  });

  test('o foco de teclado continua visível e o clique não deixa anel', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus-visible');
    await expect(focused).toHaveCount(1);
    const outline = await focused.evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(outline).not.toBe('none');
  });

  test('folha de edição: reordena, cancela e aplica', async ({ page }, info) => {
    // A escolha da Início é guardada por conta, e sem conta conhecida nada é gravado. Aqui não há API: o aparelho abre
    // como numa partida sem rede de quem já entrou antes, com a dica da conta da última sessão.
    await page.addInitScript(() => localStorage.setItem('uniover.account-id', 'u1'));
    await page.goto('/');
    const titles = blocks(page).locator('h3');
    await expect(titles).toHaveText(['TV', 'Treino', ...PLANNED]);

    await page.getByRole('button', { name: 'Editar' }).click();
    const sheet = page.getByRole('dialog', { name: 'Personalizar' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Concluir', exact: true })).toBeVisible();
    await settle(page); // fim da animação de subida
    await screenshot(page, `test-results/sheet-${info.project.name}.png`);
    await expectNoSeriousA11yViolations(page);

    // O título fica no centro real da folha, o "Concluir" não o empurra; e as setas só existem para teclado e leitor de tela.
    const box = async (locator: Locator) => (await locator.boundingBox())!;
    const sheetBox = await box(sheet);
    const titleBox = await box(sheet.getByRole('heading', { name: 'Personalizar' }));
    expect(
      Math.abs(titleBox.x + titleBox.width / 2 - (sheetBox.x + sheetBox.width / 2)),
    ).toBeLessThan(1.5);
    const moves = await box(sheet.locator('.moves').first());
    expect(moves.width).toBeLessThanOrEqual(1);

    await sheet.getByRole('heading', { name: 'Personalizar' }).click();
    await sheet.click({ position: { x: 1, y: 1 } }); // espaço interno da folha
    await expect(sheet).toBeVisible();
    await page.mouse.click(4, 4); // fora do retângulo da folha
    await expect
      .poll(() => sheet.evaluate((dialog) => dialog.classList.contains('closing')))
      .toBe(true);
    await expect(sheet).toBeHidden();

    await page.getByRole('button', { name: 'Editar' }).click();
    await expect(sheet).toBeVisible();

    // Esc descarta o que foi feito na folha.
    await sheet.getByRole('button', { name: 'Descer TV' }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(titles).toHaveText(['TV', 'Treino', ...PLANNED]);

    // Concluir guarda a nova ordem.
    await page.getByRole('button', { name: 'Editar' }).click();
    await sheet.getByRole('button', { name: 'Descer TV' }).focus();
    await page.keyboard.press('Enter');
    await sheet.getByRole('button', { name: 'Concluir' }).click();
    await expect(sheet).toBeHidden();
    await expect(titles).toHaveText(['Treino', 'TV', ...PLANNED]);

    // A escolha fica no aparelho: sobrevive ao recarregamento.
    await page.reload();
    await expect(titles).toHaveText(['Treino', 'TV', ...PLANNED]);

    // Módulo desligado some da grade.
    await page.getByRole('button', { name: 'Editar' }).click();
    await sheet.locator('li', { hasText: 'Treino' }).getByRole('switch').uncheck();
    await sheet.getByRole('button', { name: 'Concluir' }).click();
    await expect(titles).toHaveText(['TV', ...PLANNED]);

    // Um módulo em breve também pode ser ocultado.
    await page.getByRole('button', { name: 'Editar' }).click();
    await sheet.locator('li', { hasText: 'Rede da Casa' }).getByRole('switch').uncheck();
    await sheet.getByRole('button', { name: 'Concluir' }).click();
    await expect(titles).toHaveText(['TV', ...PLANNED.filter((name) => name !== 'Rede da Casa')]);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`acessibilidade (axe) no tema ${scheme}`, async ({ page }) => {
      // Movimento reduzido: as animações de entrada (`ui-rise`, avisos) saem do caminho e o axe mede cores finais. Com
      // animação, no executor lento o contraste era medido com o elemento ainda semitransparente (`.notice` na `/tv`).
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.goto('/');
      await expect(blocks(page)).toHaveCount(MODULE_COUNT);
      await settle(page);
      await expectNoSeriousA11yViolations(page);
      await page.goto('/tv');
      await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
      await settle(page);
      await expectNoSeriousA11yViolations(page);
    });
  }

  test('a CSP do servidor de teste não tem unsafe-inline', async ({ request }) => {
    const response = await request.get('/');
    const csp = response.headers()['content-security-policy'];
    expect(csp).toContain("script-src 'self'");
    const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(await response.text()).toContain(`<script nonce="${nonce}">`);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });
});

test.describe('casca offline e service worker', () => {
  test('depois de uma visita, recarregar sem rede mostra a casca', async ({ page, context }) => {
    await page.goto('/');
    await waitForServiceWorkerControl(page);

    await context.setOffline(true);
    await page.reload();
    // Sem rede e sem estado lembrado a casca abre com a marca e sem ponto: não há o que afirmar sobre o agente.
    await expect(page.locator('.brand')).toBeVisible();
    await expect(agentIndicator(page)).toHaveCount(0);
    await expect(blocks(page)).toHaveCount(MODULE_COUNT);
    await expect(status(page, 'Sem conexão')).toBeVisible();
    await expect(status(page, 'Acordando')).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    await context.setOffline(false);
    await expect(status(page, 'Sem conexão')).toBeHidden();
  });

  test('recarregar /tv/ com o worker no controle mantém o manifest da TV, online e offline', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await waitForServiceWorkerControl(page);
    const manifest = page.locator('head link[rel="manifest"]');

    for (const url of ['/tv/', '/tv', '/treino/']) {
      const slug = url.split('/')[1];
      await page.goto(url);
      await expect(manifest).toHaveAttribute('href', `/${slug}/manifest.webmanifest`);
      await page.reload();
      await expect(manifest).toHaveAttribute('href', `/${slug}/manifest.webmanifest`);

      await context.setOffline(true);
      await page.reload();
      await expect(manifest).toHaveAttribute('href', `/${slug}/manifest.webmanifest`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await context.setOffline(false);
    }

    await page.goto('/');
    await expect(manifest).toHaveAttribute('href', '/manifest.webmanifest');
  });

  test('versão nova do service worker assume sozinha e atende a próxima abertura', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.goto('/');
    await waitForServiceWorkerControl(page);
    // O servidor de teste devolve um sw.js diferente quando este cookie existe.
    await context.addCookies([{ name: 'sw-variant', value: '2', url: baseURL! }]);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error('registro ausente');
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        });
        void registration.update();
      });
    });
    await page.reload();
    await waitForServiceWorkerControl(page);
    await expect(blocks(page)).toHaveCount(MODULE_COUNT);
  });
});
