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
    const turn = await page.evaluate(async (label) => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.faces button')).find(
        (node) => node.textContent?.trim() === label,
      )!;
      button.focus();
      button.click();
      await new Promise(requestAnimationFrame);
      const figure = document.querySelector('app-body-figure svg')!;
      const animation = figure.getAnimations()[0];
      return {
        frames: (animation?.effect as KeyframeEffect | undefined)?.getKeyframes(),
        duration: animation?.effect?.getTiming().duration,
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
