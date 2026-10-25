import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { expectNoA11yViolations } from '../screens/screen-helpers';
import { openMap, showFace, zone } from './body-map-kit';
import { startTraining } from './support/training-pages';

test.use({ serviceWorkers: 'block' });

test('a figura gira nos dois sentidos com uma única face interativa', async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await startTraining(context, page);
  await openMap(page);

  for (const face of ['Costas', 'Frente'] as const) {
    // A animação nasce depois da renderização que o clique agenda e dura 240 ms: olhar `getAnimations()` num quadro
    // fixo perde a corrida (ainda não nasceu, ou já acabou) quando a máquina está ocupada. Registrar a chamada de
    // `animate` prova o mesmo (duração e primeiro quadro) sem depender de tempo.
    const turn = await page.evaluate(async (label) => {
      const calls: { frames: Keyframe[]; duration: unknown }[] = [];
      const original = Element.prototype.animate;
      Element.prototype.animate = function (
        this: Element,
        frames: Keyframe[] | PropertyIndexedKeyframes | null,
        options?: number | KeyframeAnimationOptions,
      ) {
        if (this.matches('app-body-figure svg')) {
          calls.push({
            frames: frames as Keyframe[],
            duration: typeof options === 'number' ? options : options?.duration,
          });
        }
        return original.call(this, frames, options);
      };
      try {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>('.faces button'),
        ).find((node) => node.textContent?.trim() === label)!;
        button.focus();
        button.click();
        const limit = performance.now() + 4_000;
        while (calls.length === 0 && performance.now() < limit) {
          await new Promise(requestAnimationFrame);
        }
      } finally {
        Element.prototype.animate = original;
      }
      const figure = document.querySelector('app-body-figure svg')!;
      return {
        frames: calls[0]?.frames,
        duration: calls[0]?.duration,
        figures: document.querySelectorAll('app-body-figure svg').length,
        height: figure.getBoundingClientRect().height,
      };
    }, face);
    expect(turn.duration).toBe(240);
    expect(turn.frames?.[0].transform).toContain(
      face === 'Costas' ? 'rotateY(24deg)' : 'rotateY(-24deg)',
    );
    expect(turn.figures).toBe(1);
    expect(turn.height).toBeGreaterThanOrEqual(320);
    await expect(zone(page, face === 'Costas' ? 'lats' : 'chest')).toBeVisible();
    await expect(zone(page, face === 'Costas' ? 'chest' : 'lats')).toHaveCount(0);
    await expect(page.getByRole('button', { name: face, exact: true })).toBeFocused();
    await expectNoHorizontalScroll(page);
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`movimento reduzido troca a face imediatamente no tema ${theme}`, async ({
    page,
    context,
  }, info) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await startTraining(context, page);
    await openMap(page);
    await expectNoA11yViolations(page);
    await screenshot(page, info.outputPath(`map-${theme}-front.png`));
    await showFace(page, 'Costas');
    await expect(zone(page, 'lats')).toBeVisible();
    const motion = await page.evaluate(() => ({
      animations: document.querySelector('app-body-figure svg')!.getAnimations().length,
      indicator: getComputedStyle(document.querySelector('.faces')!, '::before').transitionDuration,
    }));
    expect(motion).toEqual({ animations: 0, indicator: '0s' });
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await screenshot(page, info.outputPath(`map-${theme}-back.png`));
  });
}
