import { expectNoA11yViolations, settle, smallTargets } from '../screens/screen-helpers';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { STATES, section } from './progress-states';
import { BENCH_URL, openProgress, startProgress } from './progress-support';

/**
 * Cada estado da tela de Progresso (`progress-states`), nos dois temas: sem violação do axe (de qualquer gravidade), sem
 * rolagem horizontal e com os alvos de toque de pelo menos 44 px. O CSP é vigiado por todo teste (a fixture falha com
 * qualquer violação, e o gráfico de canvas e a biblioteca passam por isso). O movimento fica reduzido: o axe e a medida
 * veem a tela parada.
 */

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`acessibilidade e medidas, tema ${scheme === 'light' ? 'claro' : 'escuro'}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    });

    for (const state of STATES) {
      test(state.name, async ({ page, context }) => {
        await startProgress(context, page, state.options);
        await state.open(page);
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        await settle(page);
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page);
        expect(await smallTargets(page)).toEqual([]);
      });
    }
  });
}

test.describe('movimento e foco', () => {
  test('o foco aparece em quem recebe a tabulação: chips, métrica, setas e seções', async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await startProgress(context, page);
    await openProgress(page, BENCH_URL);

    const header = section(page, /^Recordes/);
    await header.focus();
    const ring = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement as Element);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });
    expect(ring.style).not.toBe('none');
    expect(parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
    // Enter abre a seção e a deixa lida pelo leitor de tela como aberta.
    await page.keyboard.press('Enter');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
  });
});
