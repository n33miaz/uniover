import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';
import {
  expect,
  expectNoHorizontalScroll,
  screenshot,
  test,
  waitForServiceWorkerControl,
} from './fixtures';

const chips = (page: Page) => page.getByRole('list', { name: 'Informações úteis' });
const blocks = (page: Page) => page.locator('article.card');
const status = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });

async function expectNoSeriousA11yViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

test.describe('início e navegação', () => {
  test('mostra a faixa e os blocos, entra em /tv e volta pelo Início', async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Bom dia|Boa tarde|Boa noite/);
    await expect(chips(page)).toContainText('Agente sem dados');
    await expect(chips(page)).toContainText('Vigia sem dados');
    await expect(blocks(page)).toHaveCount(2);
    await expect(page.getByRole('navigation', { name: 'Abas do módulo' })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await screenshot(page, `test-results/home-${info.project.name}.png`);

    await page.getByRole('link', { name: 'Abrir controle' }).click();
    await expect(page).toHaveURL(/\/tv$/);
    await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Abas do módulo' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await screenshot(page, `test-results/tv-${info.project.name}.png`);

    await page.getByRole('link', { name: /Início/ }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(blocks(page)).toHaveCount(2);
  });

  test('segue o tema escuro do sistema', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('folha de edição: reordena, redimensiona, cancela e aplica', async ({ page }, info) => {
    await page.goto('/');
    const titles = blocks(page).locator('h3');
    await expect(titles).toHaveText(['TV', 'Treino']);

    await page.getByRole('button', { name: 'Editar' }).click();
    const sheet = page.getByRole('dialog', { name: 'Editar a Início' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: /fechar|close/i })).toHaveCount(0);
    await page.waitForTimeout(400); // fim da animação de subida
    await screenshot(page, `test-results/sheet-${info.project.name}.png`);
    await expectNoSeriousA11yViolations(page);

    // Cancelar descarta o que foi feito na folha.
    await sheet.getByRole('button', { name: 'Descer TV' }).click();
    await sheet.getByRole('button', { name: 'Cancelar' }).click();
    await expect(sheet).toBeHidden();
    await expect(titles).toHaveText(['TV', 'Treino']);

    // Aplicar guarda a nova ordem e o novo tamanho.
    await page.getByRole('button', { name: 'Editar' }).click();
    await sheet.getByRole('button', { name: 'Descer TV' }).click();
    await sheet.locator('li', { hasText: 'TV' }).getByRole('button', { name: 'Largo' }).click();
    await sheet.getByRole('button', { name: 'Aplicar' }).click();
    await expect(sheet).toBeHidden();
    await expect(titles).toHaveText(['Treino', 'TV']);
    await expect(page.locator('li.widget.wide')).toHaveCount(2);

    // A escolha fica no aparelho: sobrevive ao recarregamento.
    await page.reload();
    await expect(titles).toHaveText(['Treino', 'TV']);

    // Módulo desligado some da grade.
    await page.getByRole('button', { name: 'Editar' }).click();
    await sheet.locator('li', { hasText: 'Treino' }).getByLabel('Mostrar na Início').uncheck();
    await sheet.getByRole('button', { name: 'Aplicar' }).click();
    await expect(titles).toHaveText(['TV']);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`acessibilidade (axe) no tema ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/');
      await expect(blocks(page)).toHaveCount(2);
      await expectNoSeriousA11yViolations(page);
      await page.goto('/tv');
      await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
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
    await expect(chips(page)).toBeVisible();
    await expect(blocks(page)).toHaveCount(2);
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
    await expect(blocks(page)).toHaveCount(2);
  });
});
