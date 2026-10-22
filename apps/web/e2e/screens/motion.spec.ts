import { Page } from '@playwright/test';
import { IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, screenshot, test } from '../fixtures';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { settle } from './screen-helpers';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** O que o script de observação guarda na página para os testes lerem. */
interface Motion {
  /** Nome de cada animação CSS que começou (ui-rise, ui-collapse-in, ...). */
  animations: string[];
}

let identity: IdentityMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  await mockTvApi(context, identity);
  await installFakeEventSource(page);
  // Anota de dentro da página cada animação que começa: as entradas duram 200 a 360 ms e somem, então amostrar de
  // fora é frágil. O script só lê; não muda o comportamento do app.
  await page.addInitScript(() => {
    const motion: Motion = { animations: [] };
    (window as unknown as { __motion: Motion }).__motion = motion;
    document.addEventListener(
      'animationstart',
      (event) => motion.animations.push(event.animationName),
      true,
    );
  });
});

const motion = (page: Page) =>
  page.evaluate(() => (window as unknown as { __motion: Motion }).__motion);

async function openHome(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    OWNER.displayName.split(' ')[0],
  );
  await expect(page.locator('article.card')).toHaveCount(8);
  await settle(page);
}

const toSettings = (page: Page) =>
  page
    .getByRole('link', { name: /Ajustes/ })
    .first()
    .click();
const settingsReady = (page: Page) =>
  expect(page.getByRole('heading', { level: 2, name: 'Conta' })).toBeVisible();
const sectionDelays = (page: Page) =>
  page.locator('.settings > *').evaluateAll((sections) =>
    sections.map((section) => {
      const style = getComputedStyle(section);
      return `${style.animationName}@${style.animationDelay}`;
    }),
  );

test.describe('troca de tela', () => {
  test('a tela nova entra em cascata e o print sai dela, não da tela antiga', async ({
    page,
  }, info) => {
    await openHome(page);
    const seen = (await motion(page)).animations.length;

    await toSettings(page);
    await settingsReady(page);
    // Os três grupos da lista de Ajustes entram um depois do outro (atraso de 50 ms por posição).
    await expect
      .poll(
        async () =>
          (await motion(page)).animations.slice(seen).filter((n) => n === 'ui-rise').length,
      )
      .toBeGreaterThanOrEqual(3);
    const delays = await sectionDelays(page);
    expect(delays.slice(0, 3)).toEqual(['ui-rise@0s', 'ui-rise@0.05s', 'ui-rise@0.1s']);
    await settle(page);
    await screenshot(page, `test-results/motion/settings-after-route-${info.project.name}.png`);

    // Voltar pela seta: a Início volta inteira e clicável, e a folha de edição abre.
    await page.getByRole('link', { name: 'Voltar ao Início' }).click();
    await expect(page.locator('app-home-page h1')).toContainText(OWNER.displayName.split(' ')[0]);
    await expect(page.locator('article.card')).toHaveCount(8);
    await settle(page);
    await page.getByRole('button', { name: 'Editar' }).click();
    await expect(page.getByRole('dialog', { name: 'Editar a Início' })).toBeVisible();
  });

  test('a tela nova não é coberta por nenhuma camada de transição durante a troca', async ({
    page,
  }) => {
    await openHome(page);
    await toSettings(page);
    // Nenhuma camada cobre a tela nem rouba o toque durante a entrada: o elemento no centro é da tela nova.
    const covering = await page.evaluate(() => {
      const hit = document.elementFromPoint(window.innerWidth / 2, 60);
      return { isRoot: hit === document.documentElement, inApp: !!hit?.closest('app-root') };
    });
    expect(covering).toEqual({ isRoot: false, inApp: true });
    await settingsReady(page);
  });

  test('com movimento reduzido a tela nova entra na hora, sem animação', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openHome(page);
    const seen = (await motion(page)).animations.length;
    await toSettings(page);
    await settingsReady(page);

    expect((await motion(page)).animations.slice(seen)).toEqual([]);
    const names = (await sectionDelays(page)).map((entry) => entry.split('@')[0]);
    expect(new Set(names)).toEqual(new Set(['none']));
  });
});

test.describe('folhas e avisos', () => {
  test('a folha sobe ao abrir e desce antes de sair do DOM', async ({ page }) => {
    await openHome(page);
    await page.getByRole('button', { name: 'Editar' }).click();
    const sheet = page.getByRole('dialog', { name: 'Editar a Início' });
    await expect(sheet).toBeVisible();
    // Entrada: a folha parte de um estado transparente e deslocado e vai ao estado final por transição.
    const entering = await sheet.evaluate((dialog) =>
      dialog
        .getAnimations()
        .map((a) => (a as CSSTransition).transitionProperty)
        .filter(Boolean),
    );
    expect(entering).toEqual(expect.arrayContaining(['opacity', 'translate']));
    await settle(page);

    // Saída: ao cancelar, a folha ganha a classe `closing` e fica no DOM durante o esmaecer (160 ms).
    const exit = await sheet.evaluate(async (dialog) => {
      (dialog.querySelector('.footer .secondary') as HTMLElement).click();
      const start = performance.now();
      let sawClosing = false;
      while (document.contains(dialog) && performance.now() - start < 1500) {
        if (dialog.classList.contains('closing')) sawClosing = true;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return { sawClosing, gone: !document.contains(dialog), ms: performance.now() - start };
    });
    expect(exit.sawClosing).toBe(true);
    expect(exit.gone).toBe(true);
    // Só o piso vale como prova de que a folha esperou o esmaecer. O teto não é afirmado: o tempo-limite de segurança é de
    // 300 ms, mas um executor lento atrasa os quadros (724 ms na CI); `gone` já garante que ela saiu dentro de 1,5 s.
    expect(exit.ms).toBeGreaterThan(100);
    await expect(sheet).toBeHidden();
  });

  test('o aviso de conexão abre e fecha empurrando a tela, sem salto', async ({
    page,
    context,
  }) => {
    await openHome(page);
    await page.evaluate(() => {
      (window as unknown as { __left: number }).__left = 0;
      new MutationObserver(() => {
        if (document.querySelector('.ui-collapse.leaving')) {
          (window as unknown as { __left: number }).__left += 1;
        }
      }).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    });
    const banner = page.getByRole('status').filter({ hasText: 'Sem conexão' });

    await context.setOffline(true);
    await expect(banner).toBeVisible();
    expect((await motion(page)).animations).toContain('ui-collapse-in');

    await context.setOffline(false);
    await expect(banner).toBeHidden();
    expect(
      await page.evaluate(() => (window as unknown as { __left: number }).__left),
    ).toBeGreaterThan(0);
    expect((await motion(page)).animations).toContain('ui-collapse-out');
    await expect(page.locator('.ui-collapse')).toHaveCount(0);
  });
});

test.describe('movimento reduzido', () => {
  /** Animações que ainda rodam e duram mais que um piscar (as infinitas contam: nada deve girar ou brilhar). */
  const longAnimations = (page: Page) =>
    page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => {
          const timing = animation.effect?.getComputedTiming();
          return (
            animation.playState === 'running' &&
            (timing?.iterations === Infinity || Number(timing?.duration) > 50)
          );
        })
        .map(
          (animation) =>
            (animation as CSSAnimation).animationName ??
            (animation as CSSTransition).transitionProperty,
        ),
    );

  test('nenhuma animação longa roda na Início, na folha e nos Ajustes', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      OWNER.displayName.split(' ')[0],
    );
    await expect(page.locator('article.card')).toHaveCount(8);
    expect(await longAnimations(page)).toEqual([]);

    await page.getByRole('button', { name: 'Editar' }).click();
    const sheet = page.getByRole('dialog', { name: 'Editar a Início' });
    await expect(sheet).toBeVisible();
    expect(await longAnimations(page)).toEqual([]);
    expect(await sheet.evaluate((dialog) => getComputedStyle(dialog).transitionDuration)).toBe(
      '0s',
    );
    // Sem animação, o fundo também fecha a folha na hora.
    await page.mouse.click(4, 4);
    await expect(sheet).toBeHidden({ timeout: 250 });

    await toSettings(page);
    await settingsReady(page);
    expect(await longAnimations(page)).toEqual([]);
  });
});
