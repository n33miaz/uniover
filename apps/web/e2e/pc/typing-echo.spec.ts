import { join } from 'node:path';
import { Page, TestInfo } from '@playwright/test';
import { mockIdentityApi } from '../auth/identity-mock';
import { expect, screenshot, test } from '../fixtures';
import { afterFrames, settle } from '../screens/screen-helpers';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { READY, mockPcApi } from './pc-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Onde vão os prints (quem roda o teste aponta uma pasta); sem a variável, ficam em `test-results`. */
const SHOTS = process.env['PC_SHOTS'] ?? 'test-results';

/**
 * O teclado de cada aparelho-alvo, em pixels do CSS: no iPhone 12 o teclado com a barra de sugestões; no S23 FE o teclado da
 * Samsung com a barra de ferramentas.
 */
const KEYBOARD: Record<string, number> = { 'iphone-12': 336, 's23-fe': 340 };

/**
 * Um `visualViewport` falso (o Playwright não abre teclado). No iPhone a janela não encolhe: o teclado cobre a parte de baixo
 * e o Safari ainda rola a área visível para mostrar o campo focado (`offsetTop`). No Android a página encolhe sozinha
 * (`interactive-widget=resizes-content`): a área visível é a janela inteira, já menor.
 */
async function installFakeKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let covered = 0;
    let offset = 0;
    const target = new EventTarget();
    Object.defineProperties(target, {
      height: { get: () => window.innerHeight - covered },
      offsetTop: { get: () => offset },
      width: { get: () => window.innerWidth },
    });
    Object.defineProperty(window, 'visualViewport', { value: target, configurable: true });
    // Como no iPhone: primeiro a área visível encolhe (o teclado sobe) e só depois o Safari a rola até o campo.
    (window as unknown as Record<string, unknown>)['__keyboard'] = (px: number, top: number) => {
      covered = px;
      offset = 0;
      target.dispatchEvent(new Event('resize'));
      offset = top;
      target.dispatchEvent(new Event('scroll'));
    };
  });
}

/** Abre o teclado do aparelho do projeto: cobre a janela (iPhone) ou a encolhe (Android). */
async function openPhoneKeyboard(page: Page, info: TestInfo, reveal: boolean): Promise<void> {
  const keyboard = KEYBOARD[info.project.name] ?? 336;
  if (info.project.name === 's23-fe') {
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width, height: size.height - keyboard });
    await page.evaluate(() =>
      (window as never as { __keyboard(px: number, top: number): void }).__keyboard(0, 0),
    );
  } else {
    // Como o Safari: com `reveal`, a área visível desce até mostrar o campo focado (o campo escondido, embaixo da tela).
    const field = (await page.getByLabel('Digitar no PC').boundingBox())!;
    const height = page.viewportSize()!.height;
    const top = reveal
      ? Math.min(Math.max(0, field.y + field.height - (height - keyboard)), keyboard)
      : 0;
    await page.evaluate(
      ([px, offset]) =>
        (window as never as { __keyboard(px: number, top: number): void }).__keyboard(px, offset),
      [keyboard, top] as const,
    );
  }
  await afterFrames(page, 4);
}

/** A parte visível agora (o que não está atrás do teclado nem rolado para fora), em coordenadas da janela. */
function visibleArea(page: Page) {
  return page.evaluate(() => {
    const viewport = window.visualViewport!;
    return { top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height };
  });
}

async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  expect(box, selector).not.toBeNull();
  return box!;
}

test.describe('o eco do que se digita no PC fica à vista com o teclado do celular aberto', () => {
  test.beforeEach(async ({ context, page }) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    const pc = await mockPcApi(context, identity);
    pc.status = { ...READY, apps: [...READY.apps], capabilities: ['pc.key.v2', 'pc.text.v2'] };
    await mockTvApi(context, identity);
    await installFakeEventSource(page);
    await installFakeKeyboard(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  for (const reveal of [false, true]) {
    test(`acima do teclado, abaixo do topo e à esquerda${reveal ? ' (o Safari rola até o campo)' : ''}`, async ({
      page,
    }, info) => {
      test.skip(reveal && info.project.name !== 'iphone-12', 'só o Safari rola a área visível');
      await page.goto('/pc');
      await expect(page.getByRole('heading', { level: 1, name: 'Controle do PC' })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: /Conectado|Sem/ })).toHaveText(
        'Conectado',
      );
      await settle(page);
      await page.getByRole('button', { name: 'Teclado', exact: true }).click();
      const field = page.getByLabel('Digitar no PC');
      await expect(field).toBeFocused();
      await openPhoneKeyboard(page, info, reveal);
      await page.keyboard.type('senha123');
      await expect(page.locator('.echo-line')).toHaveText('senha123');
      await afterFrames(page, 4);

      const visible = await visibleArea(page);
      const echo = await boxOf(page, '.echo');
      const text = await boxOf(page, '.echo-text');
      const bar = await boxOf(page, 'app-pc-action-bar');
      const header = await page.locator('app-shell header, header').first().boundingBox();
      // Inteiro dentro da parte visível: nem atrás do teclado, nem rolado para cima do topo.
      expect(echo.y, 'eco abaixo do topo visível').toBeGreaterThanOrEqual(visible.top - 0.5);
      expect(echo.y + echo.height, 'eco acima do teclado').toBeLessThanOrEqual(
        visible.bottom + 0.5,
      );
      // Nem atrás do cabeçalho fixo nem da barra de ações.
      if (header && header.y + header.height > visible.top) {
        expect(echo.y, 'eco abaixo do cabeçalho').toBeGreaterThanOrEqual(
          header.y + header.height - 0.5,
        );
      }
      expect(echo.y + echo.height, 'eco acima da barra de ações').toBeLessThanOrEqual(bar.y + 0.5);
      // A barra de ações também fica inteira acima do teclado (é por ela que se apaga, dá Enter e fecha o teclado).
      expect(bar.y + bar.height, 'barra acima do teclado').toBeLessThanOrEqual(
        visible.bottom + 0.5,
      );
      // O que se digita começa à esquerda da linha (não colado no botão de esconder, à direita).
      expect(text.x - echo.x, 'texto à esquerda').toBeLessThan(48);
      // O ponto do meio do texto é dele mesmo (nada por cima).
      const onTop = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest('.echo') !== null,
        { x: text.x + text.width / 2, y: text.y + text.height / 2 },
      );
      expect(onTop, 'nada cobre o eco').toBe(true);
      console.log(info.project.name, reveal, JSON.stringify({ visible, echo, bar, header }));
      // No print, o teclado do iPhone (que o Playwright não desenha) é uma faixa cinza, e o que está fora da parte visível fica
      // escurecido: o print mostra o que a pessoa vê.
      await page.evaluate(({ top, bottom }) => {
        const shade = (y: number, h: number, color: string) => {
          const el = document.createElement('div');
          el.className = 'test-keyboard-shade';
          el.style.cssText = `position:fixed;left:0;right:0;top:${y}px;height:${h}px;background:${color};z-index:9999;pointer-events:none`;
          document.body.append(el);
        };
        if (top > 0) shade(0, top, 'rgba(0,0,0,.55)');
        if (bottom < window.innerHeight) shade(bottom, window.innerHeight - bottom, '#8a8f98');
      }, visible);
      await screenshot(
        page,
        join(SHOTS, `eco-visivel-${info.project.name}${reveal ? '-safari-rolado' : ''}.png`),
      );
    });
  }
});
