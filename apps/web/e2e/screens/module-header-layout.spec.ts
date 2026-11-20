import { join } from 'node:path';
import { Locator } from '@playwright/test';
import { mockIdentityApi } from '../auth/identity-mock';
import { mockDevicesApi } from '../devices/devices-mock';
import { expect, screenshot, test } from '../fixtures';
import { mockPcApi } from '../pc/pc-mock';
import { mockShoppingApi } from '../shopping/shopping-mock';
import { seedTraining } from '../training/support/training-seed';
import { mockTrainingApi } from '../training/support/training-server';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { settle } from './screen-helpers';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ context, page }) => {
  const identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  await mockDevicesApi(context, identity);
  await mockPcApi(context, identity);
  await mockShoppingApi(context, identity);
  await mockTvApi(context, identity);
  seedTraining(await mockTrainingApi(context), {});
  await installFakeEventSource(page);
});

const screens = [
  ['tv', '/tv', '.tv > header'],
  ['inicio', '/', '.home-topbar'],
  ['treino', '/treino', 'app-page-top-bar header'],
  ['compras', '/compras', 'app-page-top-bar header'],
  ['pc', '/pc', 'app-page-top-bar header'],
  ['ajustes', '/ajustes', 'app-page-top-bar header'],
  ['aparelhos', '/ajustes/aparelhos', 'app-page-top-bar header'],
] as const;

async function measure(header: Locator) {
  return header.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const px = (value: string) => Number.parseFloat(value);
    return {
      top: box.top + px(style.paddingTop),
      left: box.left + px(style.paddingLeft),
      right: innerWidth - box.right + px(style.paddingRight),
      height: box.height - px(style.paddingTop) - px(style.paddingBottom),
    };
  });
}

for (const size of ['projeto', 'iphone-integral'] as const) {
  test(`os módulos alinham o cabeçalho com a TV (${size})`, async ({ page }, info) => {
    test.skip(size === 'iphone-integral' && info.project.name !== 'iphone-12');
    if (size === 'iphone-integral') await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    const results = [];
    for (const [name, route, selector] of screens) {
      await page.goto(route);
      const header = page.locator(selector);
      await expect(header).toBeVisible();
      await expect(page.locator('app-loading-frame')).toHaveCount(0);
      await settle(page);
      results.push({ name, ...(await measure(header)) });
      const folder = process.env['UI_PRINTS_DIR'];
      if (folder) await screenshot(page, join(folder, `${name}-${info.project.name}-${size}.png`));
    }
    await info.attach('medidas', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
    const [tv, ...modules] = results;
    for (const header of modules)
      expect.soft(header, header.name).toEqual({ ...tv, name: header.name });
  });
}

test('a TV mantém o topo ao alternar o tema no iPhone', async ({ page }, info) => {
  test.skip(info.project.name !== 'iphone-12');
  const measurements = [];
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto('/tv');
    const header = page.locator('.tv > header');
    await expect(header).toBeVisible();
    await settle(page);
    measurements.push(await measure(header));
    const folder = process.env['UI_PRINTS_DIR'];
    if (folder) await screenshot(page, join(folder, `tv-iphone-12-${colorScheme}.png`));
  }
  expect(measurements[0]).toEqual(measurements[1]);
});
