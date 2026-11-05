// Este spec usa o `test` do Playwright de propósito, e não o de `../fixtures`: aquele tolera, no WebKit, o par de ruído
// do `<select>` e a folha em linha que a ferramenta injeta no print. Aqui nenhuma violação é tolerada, e por isso a
// página nunca é fotografada: no WebKit, cada `page.screenshot` faz o próprio Playwright injetar um `<style>` sem nonce,
// e a CSP o barra com "Refused to apply a stylesheet ..." (`style-src-elem inline`, sem alvo nem arquivo). Medido contra
// o build de produção: sem print, zero violações em todas as telas abaixo; com print, exatamente uma por print.
import { Page } from '@playwright/test';
import { test as base, expect } from '@playwright/test';
import { mockIdentityApi } from '../auth/identity-mock';
import { mockTvApi, installFakeEventSource } from '../tv/tv-mock';
import { mockAuditApi } from '../settings/audit-mock';
import { openTraining, startTraining } from '../training/support/training-pages';

const test = base.extend<{ violations: string[] }>({
  violations: [
    async ({ page }, use) => {
      const found: string[] = [];
      await page.exposeFunction('__reportStrictCsp', (detail: string) => found.push(detail));
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          const target = event.target instanceof Element ? event.target.tagName : '';
          (window as unknown as { __reportStrictCsp(detail: string): void }).__reportStrictCsp(
            `${event.violatedDirective} ${event.blockedURI} ${event.sample} ${target} ${event.sourceFile}:${event.lineNumber}`,
          );
        });
      });
      page.on('console', (message) => {
        if (/Content Security Policy|Refused to (apply|execute|load)/i.test(message.text())) {
          found.push(`console: ${message.text()}`);
        }
      });
      await use(found);
    },
    { auto: true },
  ],
});

test.use({ serviceWorkers: 'block', locale: 'pt-BR' });

/** Folha de estilo declarada e não aplicada (sem `sheet`, ou ainda em `media="print"`) é estilo faltando em silêncio. */
async function expectEveryStylesheetApplied(page: Page): Promise<void> {
  const unapplied = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]'))
      .filter((link) => !link.sheet || (link.media !== '' && link.media !== 'all'))
      .map((link) => `${link.href} media=${link.media}`),
  );
  expect(unapplied, 'folhas de estilo não aplicadas').toEqual([]);
}

const TRAINING_ROUTES = ['/treino/rotinas', '/treino/progresso', '/treino/corpo'];

test.describe('CSP estrita: nenhuma violação de estilo nas telas lazy', () => {
  for (const route of TRAINING_ROUTES) {
    test(`Treino ${route}`, async ({ page, context, violations }) => {
      await startTraining(context, page);
      await openTraining(page, route);
      // Dá tempo às folhas adiadas e aos estilos de componente carregarem antes de conferir.
      await page.waitForLoadState('networkidle');
      await expectEveryStylesheetApplied(page);
      expect(violations, 'violações de CSP').toEqual([]);
    });
  }

  test('Ajustes: auditoria, com a folha de filtros aberta', async ({
    page,
    context,
    violations,
  }) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    await mockTvApi(context, identity);
    await mockAuditApi(context, identity);
    await installFakeEventSource(page);
    await page.goto('/ajustes/auditoria');
    await expect(page.getByRole('heading', { level: 1, name: 'Auditoria' })).toBeVisible();
    await page.getByRole('button', { name: /filtr/i }).first().click();
    await page.waitForLoadState('networkidle');
    await expectEveryStylesheetApplied(page);
    expect(violations, 'violações de CSP').toEqual([]);
  });
});
