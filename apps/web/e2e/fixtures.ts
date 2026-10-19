import { expect, test as base, Page } from '@playwright/test';

// Páginas cujo registro de violações está silenciado (ver `screenshot`).
const muted = new WeakSet<Page>();

/**
 * Todo teste falha se a página violar a CSP, online ou offline. Escuta o evento do navegador e as mensagens
 * de console (o WebKit nem sempre dispara o evento para tudo que bloqueia).
 */
export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: [
    async ({ page }, use) => {
      const violations: string[] = [];
      await page.exposeFunction('__reportCsp', (detail: string) => {
        if (!muted.has(page)) violations.push(detail);
      });
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          (window as unknown as { __reportCsp(detail: string): void }).__reportCsp(
            `${event.violatedDirective} ${event.blockedURI} ${event.sample} ${event.sourceFile}:${event.lineNumber}`,
          );
        });
      });
      page.on('console', (message) => {
        if (muted.has(page)) return;
        if (/Content Security Policy|Refused to (apply|execute|load)/i.test(message.text())) {
          violations.push(message.text());
        }
      });
      await use(violations);
      expect(violations, 'violações de CSP').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Espera o service worker estar instalado e controlando a página (a casca já está em cache). */
export async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      );
    }
  });
}

/**
 * Print da tela. No WebKit o Playwright injeta uma folha de estilo em linha para tirar o print, e a CSP a
 * bloqueia: isso é da ferramenta, não do app. Só durante o print o registro de violações fica silenciado.
 */
export async function screenshot(page: Page, path: string): Promise<void> {
  muted.add(page);
  try {
    await page.screenshot({ path });
    await page.evaluate(() => undefined); // deixa chegarem as mensagens pendentes antes de voltar a registrar
  } finally {
    muted.delete(page);
  }
}
