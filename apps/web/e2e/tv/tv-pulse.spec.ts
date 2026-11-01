import { Page } from '@playwright/test';
import { IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, test } from '../fixtures';
import { TvMock, emitSse, installFakeEventSource, mockTvApi, sseUrls } from './tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

let identity: IdentityMock;
let tv: TvMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  tv = await mockTvApi(context, identity);
  await installFakeEventSource(page);
});

async function openTv(page: Page) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/tv');
  await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
  await emitSse(page, 'tv.state', tv.state);
  await emitSse(page, 'tv.shortcuts', tv.shortcuts);
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeVisible();
}

const header = (page: Page) => page.locator('.tv > header.head');
const statusButton = (page: Page) =>
  header(page).getByRole('button', { name: /^Estado do controle:/ });

test('o ponto de estado pisca uma vez a cada toque em qualquer botão, sem trocar de cor', async ({
  page,
}) => {
  await openTv(page);
  const dot = statusButton(page).locator('app-status-dot');
  const color = () => dot.locator('.dot').evaluate((svg) => getComputedStyle(svg).color);
  const restingColor = await color();
  await expect(dot).toHaveAttribute('data-pulses', '0');

  // Uma tecla da direção, uma do volume e um botão redondo: cada toque conta um pulso.
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(dot).toHaveAttribute('data-pulses', '1');
  await page.getByRole('button', { name: 'Aumentar o volume' }).click();
  await expect(dot).toHaveAttribute('data-pulses', '2');
  await page.getByRole('button', { name: 'Mudo' }).click();
  await expect(dot).toHaveAttribute('data-pulses', '3');

  // O pulso é só brilho: terminado, a cor é a de estado de sempre e nada ficou animando.
  await expect
    .poll(() => dot.locator('.dot').evaluate((svg) => svg.getAnimations().length))
    .toBe(0);
  expect(await color()).toBe(restingColor);
  await expect(statusButton(page)).toHaveAttribute('data-phase', 'connected');
});

test('com movimento reduzido o pulso continua contando, só com variação suave de opacidade', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openTv(page);
  const dot = statusButton(page).locator('app-status-dot');
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(dot).toHaveAttribute('data-pulses', '1');
  const keyframes = await dot.locator('.dot').evaluate(async (svg) => {
    // O pulso dura ~250 ms: o teste pega a animação logo depois do toque, ou já terminada (aí não há o que ver).
    const animation = svg.getAnimations()[0];
    return animation
      ? (animation.effect as KeyframeEffect).getKeyframes().map((k) => Object.keys(k))
      : null;
  });
  if (keyframes) {
    for (const names of keyframes) {
      expect(names).not.toContain('transform');
      expect(names).not.toContain('filter');
    }
  }
});

test('o ponto de estado fica colado ao desligar, sem sobrepor os alvos de toque', async ({
  page,
}) => {
  await openTv(page);
  const trigger = (await statusButton(page).boundingBox())!;
  const dotBox = (await statusButton(page).locator('.dot').boundingBox())!;
  const power = (await header(page).getByRole('button', { name: 'Desligar a TV' }).boundingBox())!;
  // O alvo continua com 44 px e termina onde o desligar começa (sem sobrepor).
  expect(trigger.width).toBeGreaterThanOrEqual(44);
  expect(trigger.x + trigger.width).toBeLessThanOrEqual(power.x);
  // O ponto que se vê está a poucos pixels do círculo do desligar (antes eram quase 20).
  expect(power.x - (dotBox.x + dotBox.width)).toBeLessThanOrEqual(12);
});
