import { Page } from '@playwright/test';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { mockIdentityApi, newQrServer } from './identity-mock';

test.use({ serviceWorkers: 'block' });

async function expectUsableCard(page: Page, buttonName: string): Promise<void> {
  await expectNoHorizontalScroll(page);
  const bounds = await page.locator('app-auth-layout .card').boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const button = page.getByRole('button', { name: buttonName, exact: true });
  await expect(button).toBeVisible();
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
}

for (const width of [280, 320]) {
  test(`entrada e convite continuam utilizáveis em ${width} px`, async ({
    page,
    context,
  }, info) => {
    await mockIdentityApi(context);
    await page.setViewportSize({ width, height: 568 });
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await page.goto('/entrar');
    await expect(page.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
    await expectUsableCard(page, 'Entrar');
    await screenshot(page, info.outputPath(`login-${width}.png`), { fullPage: true });

    await page.goto(`/convite#${'a'.repeat(43)}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Criar conta' })).toBeVisible();
    await expectUsableCard(page, 'Continuar');
    await screenshot(page, info.outputPath(`invite-${width}.png`), { fullPage: true });
  });

  test(`boas-vindas e aprovação por QR continuam utilizáveis em ${width} px`, async ({
    page,
    context,
  }, info) => {
    const qr = newQrServer();
    qr.requests.push({
      code: 'Qr1aaaaaaaaaaaaa',
      secret: 'segredo-do-pc',
      userAgent: 'Windows',
      status: 'pending',
    });
    qr.verification = 'password';
    qr.sameNetwork = false;
    const identity = await mockIdentityApi(context, { qr });
    identity.loggedIn = true;
    identity.owner.confirmed = false;
    await page.setViewportSize({ width, height: 568 });
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await page.goto('/boas-vindas');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Como devemos te chamar?' }),
    ).toBeVisible();
    await expectUsableCard(page, 'Continuar');
    await screenshot(page, info.outputPath(`welcome-${width}.png`), { fullPage: true });

    identity.owner.confirmed = true;
    await page.goto(`/entrar/qr?codigo=${qr.requests[0].code}`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Entrar no computador?' }),
    ).toBeVisible();
    await expectUsableCard(page, 'Confirmar');
    await expect(page.locator('.device')).toHaveText('Windows');
    const deviceStyle = await page.locator('.device').evaluate((device) => {
      const style = getComputedStyle(device);
      return {
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      };
    });
    expect(deviceStyle.textOverflow).not.toBe('ellipsis');
    expect(deviceStyle.whiteSpace).not.toBe('nowrap');
    await screenshot(page, info.outputPath(`qr-${width}.png`), { fullPage: true });
    if (width === 320) {
      await page.evaluate(() => (document.documentElement.style.fontSize = '32px'));
      await expectUsableCard(page, 'Confirmar');
      const titleFits = await page
        .getByRole('heading', { level: 1 })
        .evaluate((title) => title.scrollWidth <= title.clientWidth);
      expect(titleFits).toBe(true);
      await screenshot(page, info.outputPath('qr-large-text.png'), { fullPage: true });
    }
  });
}
