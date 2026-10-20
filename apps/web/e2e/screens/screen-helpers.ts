import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';
import { expect } from '../fixtures';

/** Espera as animações de entrada terminarem para o print e o axe verem a tela parada. */
export async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished),
    ),
  );
}

/** Falha com qualquer violação do axe (inclusive leve e moderada), não só as graves. */
export async function expectNoA11yViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(
    violations.map(
      (v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
    ),
  ).toEqual([]);
}

/** Alvos de toque com menos de 44 px (interruptores e opções ganham a área do rótulo ou da linha). */
export async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const selector = 'a[href], button, input, select, textarea, [role="switch"], [role="radio"]';
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      let box = element.getBoundingClientRect();
      if (
        element instanceof HTMLInputElement &&
        (element.type === 'checkbox' || element.type === 'radio')
      ) {
        const host = element.closest('label, li');
        if (host) box = host.getBoundingClientRect();
      }
      if (box.width === 0 || box.height === 0) continue;
      if (Math.min(box.width, box.height) < 43.5) {
        const label = element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '';
        found.push(
          `${element.tagName.toLowerCase()} "${label.slice(0, 30)}" ${Math.round(box.width)}x${Math.round(box.height)}`,
        );
      }
    }
    return found;
  });
}
