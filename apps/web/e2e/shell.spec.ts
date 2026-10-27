import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';
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
  'Saúde e eventos',
  'Monitor dos serviços',
  'Rede da casa',
  'Backup de fotos',
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
    await expect(agentIndicator(page)).toHaveAttribute('aria-label', 'Agente sem dados');
    await expect(agentIndicator(page)).toHaveAttribute('title', 'Agente sem dados');
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
    await expect(planned.locator('.badges')).toHaveText(PLANNED.map(() => 'Em breve'));
    await expect(page.locator('article .desc')).toHaveCount(0);
    expect(
      await planned
        .locator('.badges')
        .evaluateAll((badges) =>
          badges.every((badge) => badge.parentElement?.matches('article.card')),
        ),
    ).toBe(true);
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

  test('segue o tema escuro do sistema', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('remove a seleção da interface sem bloquear campos de texto', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const styles = await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'text';
      const textarea = document.createElement('textarea');
      document.body.append(input, textarea);

      const read = (element: Element) => {
        const computed = getComputedStyle(element);
        return {
          userSelect: computed.userSelect,
          webkitUserSelect: computed.getPropertyValue('-webkit-user-select'),
        };
      };

      const bodyTouchCallout = getComputedStyle(document.body).getPropertyValue(
        '-webkit-touch-callout',
      );
      const result = {
        text: read(document.querySelector('h1')!),
        button: read(document.querySelector('button')!),
        input: read(input),
        textarea: read(textarea),
        bodyTouchCallout,
      };
      input.remove();
      textarea.remove();
      return result;
    });

    expect(styles.text).toMatchObject({ userSelect: 'none', webkitUserSelect: 'none' });
    expect(styles.button).toMatchObject({ userSelect: 'none', webkitUserSelect: 'none' });
    expect(styles.input).toMatchObject({ userSelect: 'text', webkitUserSelect: 'text' });
    expect(styles.textarea).toMatchObject({ userSelect: 'text', webkitUserSelect: 'text' });
    if (styles.bodyTouchCallout) {
      expect(styles.bodyTouchCallout).toBe('none');
    }
  });

  test('folha de edição: reordena, cancela e aplica', async ({ page }, info) => {
    // A escolha da Início é guardada por conta, e sem conta conhecida nada é gravado. Aqui não há API: o aparelho abre
    // como numa partida sem rede de quem já entrou antes, com a dica da conta da última sessão.
    await page.addInitScript(() => localStorage.setItem('uniover.account-id', 'u1'));
    await page.goto('/');
    const titles = blocks(page).locator('h3');
    await expect(titles).toHaveText(['TV', 'Treino', ...PLANNED]);

    await page.getByRole('button', { name: 'Editar' }).click();
    const sheet = page.getByRole('dialog', { name: 'Editar a Início' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: /fechar|close/i })).toHaveCount(0);
    await settle(page); // fim da animação de subida
    await screenshot(page, `test-results/sheet-${info.project.name}.png`);
    await expectNoSeriousA11yViolations(page);

    await sheet.getByRole('heading', { name: 'Editar a Início' }).click();
    await sheet.click({ position: { x: 1, y: 1 } }); // espaço interno da folha
    await expect(sheet).toBeVisible();
    await page.mouse.click(4, 4); // fora do retângulo da folha
    await expect
      .poll(() => sheet.evaluate((dialog) => dialog.classList.contains('closing')))
      .toBe(true);
    await expect(sheet).toBeHidden();

    await page.getByRole('button', { name: 'Editar' }).click();
    await expect(sheet).toBeVisible();

    // Cancelar descarta o que foi feito na folha.
    await sheet.getByRole('button', { name: 'Descer TV' }).click();
    await sheet.getByRole('button', { name: 'Cancelar' }).click();
    await expect(sheet).toBeHidden();
    await expect(titles).toHaveText(['TV', 'Treino', ...PLANNED]);

    // Aplicar guarda a nova ordem.
    await page.getByRole('button', { name: 'Editar' }).click();
    await sheet.getByRole('button', { name: 'Descer TV' }).click();
    await sheet.getByRole('button', { name: 'Aplicar' }).click();
    await expect(sheet).toBeHidden();
    await expect(titles).toHaveText(['Treino', 'TV', ...PLANNED]);

    // A escolha fica no aparelho: sobrevive ao recarregamento.
    await page.reload();
    await expect(titles).toHaveText(['Treino', 'TV', ...PLANNED]);

    // Módulo desligado some da grade.
    await page.getByRole('button', { name: 'Editar' }).click();
    await sheet.locator('li', { hasText: 'Treino' }).getByRole('switch').uncheck();
    await sheet.getByRole('button', { name: 'Aplicar' }).click();
    await expect(titles).toHaveText(['TV', ...PLANNED]);

    // Um módulo em breve também pode ser ocultado.
    await page.getByRole('button', { name: 'Editar' }).click();
    await sheet.locator('li', { hasText: 'Rede da casa' }).getByRole('switch').uncheck();
    await sheet.getByRole('button', { name: 'Aplicar' }).click();
    await expect(titles).toHaveText(['TV', ...PLANNED.filter((name) => name !== 'Rede da casa')]);
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
    await expect(agentIndicator(page)).toBeVisible();
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

  test('versão nova do service worker mostra o aviso e atualiza ao aceitar', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.goto('/');
    await waitForServiceWorkerControl(page);
    const banner = status(page, 'Nova versão disponível');
    await expect(banner).toHaveCount(0);

    // O servidor de teste devolve um sw.js diferente quando este cookie existe.
    await context.addCookies([{ name: 'sw-variant', value: '2', url: baseURL! }]);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });
    await expect(banner).toBeVisible();
    await settle(page);
    await screenshot(page, 'test-results/update-banner.png');

    const before = await page.evaluate(() => performance.timeOrigin);
    await banner.getByRole('button', { name: 'Atualizar' }).click();
    await expect
      .poll(() => page.evaluate(() => performance.timeOrigin).catch(() => before), {
        message: 'a página recarregou',
      })
      .not.toBe(before);
    await waitForServiceWorkerControl(page);
    await expect(banner).toHaveCount(0);
    await expect(blocks(page)).toHaveCount(MODULE_COUNT);
  });
});
