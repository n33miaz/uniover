import { expect, test as base, Page } from '@playwright/test';

// Páginas cujo registro de violações está silenciado (ver `screenshot`).
const muted = new WeakSet<Page>();

// Até quando, depois de um print, ainda se descarta a folha em linha que a ferramenta injetou. O aviso do navegador
// chega por um caminho diferente do da resposta do print e, num executor lento, pode desembarcar depois dela.
const toolStyleUntil = new WeakMap<Page, number>();
const TOOL_STYLE_GRACE_MS = 1500;
const TOOL_STYLE_EVENT = /^style-src-elem inline\b/;
const TOOL_STYLE_CONSOLE = /stylesheet|style-src/i;

function lateToolStyle(page: Page, pattern: RegExp, detail: string): boolean {
  return pattern.test(detail) && Date.now() < (toolStyleUntil.get(page) ?? 0);
}

/**
 * Chaves onde o app guarda a escolha de "Não mostrar de novo" da folha do atalho na tela de início: uma por app
 * (a raiz e cada módulo com manifest próprio).
 */
const INSTALL_HINT_KEYS = ['', '.tv', '.treino'].map(
  (suffix) => `uniover.install-hint.v1${suffix}`,
);

/**
 * Todo teste falha se a página violar a CSP, online ou offline. Escuta o evento do navegador e as mensagens
 * de console (o WebKit nem sempre dispara o evento para tudo que bloqueia).
 */
export const test = base.extend<{
  cspViolations: string[];
  installHintSilenced: boolean;
  _silenceInstallHint: void;
}>({
  /**
   * A folha "Atalho na tela de início" abre sozinha ~3 s depois da tela pronta num celular (e o projeto `iphone-12`
   * tem agente de iPhone), tornando a página inerte no meio de qualquer teste. Por padrão todo teste começa com
   * "Não mostrar de novo" já escolhido; quem testa a dica desliga com `test.use({ installHintSilenced: false })`.
   */
  installHintSilenced: [true, { option: true }],
  _silenceInstallHint: [
    async ({ context, installHintSilenced }, use) => {
      if (installHintSilenced) {
        // No contexto (e não na página): uma segunda aba aberta pelo teste também nasce silenciada.
        await context.addInitScript((keys) => {
          try {
            for (const key of keys) localStorage.setItem(key, JSON.stringify({ never: true }));
          } catch {
            // Sem armazenamento: a dica também não se lembra de nada, mas aí nada a silenciar.
          }
        }, INSTALL_HINT_KEYS);
      }
      await use(undefined);
    },
    { auto: true },
  ],
  cspViolations: [
    async ({ page }, use) => {
      const violations: string[] = [];
      await page.exposeFunction('__reportCsp', (detail: string) => {
        if (muted.has(page) || lateToolStyle(page, TOOL_STYLE_EVENT, detail)) return;
        violations.push(detail);
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
        const text = message.text();
        if (/Content Security Policy|Refused to (apply|execute|load)/i.test(text)) {
          if (!lateToolStyle(page, TOOL_STYLE_CONSOLE, text)) violations.push(text);
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
 * bloqueia: isso é da ferramenta, não do app. Durante o print o registro de violações fica silenciado; logo depois,
 * por uma janela curta, só se descarta o aviso dessa folha em linha (qualquer outra violação continua valendo).
 */
export async function screenshot(
  page: Page,
  path: string,
  options: { fullPage?: boolean } = {},
): Promise<void> {
  muted.add(page);
  try {
    await page.screenshot({ path, ...options });
    await page.evaluate(() => undefined); // deixa chegarem as mensagens pendentes antes de voltar a registrar
  } finally {
    muted.delete(page);
    toolStyleUntil.set(page, Date.now() + TOOL_STYLE_GRACE_MS);
  }
}
