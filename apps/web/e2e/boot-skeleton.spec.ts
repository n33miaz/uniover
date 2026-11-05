import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mockIdentityApi } from './auth/identity-mock';
import { expect, test } from './fixtures';

const html = readFileSync(resolve(process.cwd(), 'src/index.html'), 'utf8').replace(
  '<script src="boot-skeleton.js" defer></script>',
  '',
);
const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
const skeletonStyles = readFileSync(resolve(process.cwd(), 'src/boot-skeleton.css'), 'utf8');

const variants = [
  'home',
  'tv',
  'training-today',
  'training-session',
  'training-session-exercise',
  'training-glossary',
  'training-library',
  'training-exercise-form',
  'training-map',
  'training-exercise-detail',
  'training-routines',
  'training-routine-editor',
  'training-progress',
  'training-food',
  'training-body',
  'training-assessments',
  'training-assessment-import',
  'training-assessment-editor',
  'training-assessment-detail',
  'settings',
  'settings-profile',
  'settings-appearance',
  'settings-security',
  'settings-people',
  'settings-tv-people',
  'settings-tv-history',
  'settings-audit',
  'settings-system',
  'settings-devices',
  'settings-about',
  'settings-credits',
  'auth-login',
  'auth-qr',
  'auth-invite',
  'auth-welcome',
  'devices-connect',
] as const;

const namedContent: Readonly<Record<string, string>> = {
  'training-today': '.bs-training-today-content',
  'training-progress': '.bs-training-progress-content',
  'training-body': '.bs-training-body-content',
  'settings-profile': '.bs-settings-profile-content',
  'settings-appearance': '.bs-settings-appearance-content',
  'settings-people': '.bs-settings-data-content',
  'settings-audit': '.bs-settings-data-content',
  'settings-devices': '.bs-settings-data-content',
  'settings-system': '.bs-settings-system-content',
};

const hiddenBlocks: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'training-food': { grid: 'none', panel: 'none', strip: 'none' },
  'training-glossary': { grid: 'none', panel: 'none', strip: 'none' },
  'training-assessments': { grid: 'none', panel: 'none', strip: 'none' },
  'settings-about': { hero: 'none', grid: 'none', panel: 'none', strip: 'none' },
  'settings-security': { grid: 'none', strip: 'none' },
  'settings-siri': { grid: 'none' },
};

test('cada endereço mostra um desenho próprio e formas visíveis desde o primeiro quadro', async ({
  page,
}) => {
  await page.setContent(html);
  const firstPaint = await page.evaluate(() => {
    const root = document.getElementById('boot-skeleton')!;
    const bone = root.querySelector<HTMLElement>('.bs-home .bone')!;
    return {
      rootPosition: getComputedStyle(root).position,
      boneDisplay: getComputedStyle(bone).display,
      boneBackground: getComputedStyle(bone).backgroundColor,
    };
  });
  expect(firstPaint.rootPosition).toBe('fixed');
  expect(firstPaint.boneDisplay).toBe('block');
  expect(firstPaint.boneBackground).not.toBe('rgba(0, 0, 0, 0)');
  await page.addStyleTag({ content: styles });
  await page.addStyleTag({ content: skeletonStyles });
  // A folha crítica do index.html nunca pode vencer as externas: o osso mantém o brilho e a cor segue o tema escolhido.
  const afterSheets = await page.evaluate(() => {
    const bone = document.querySelector<HTMLElement>('#boot-skeleton .bs-home .bone')!;
    document.documentElement.setAttribute('data-theme', 'light');
    const light = getComputedStyle(bone).backgroundColor;
    const lightRoot = getComputedStyle(document.documentElement).colorScheme;
    document.documentElement.removeAttribute('data-theme');
    return { image: getComputedStyle(bone).backgroundImage, light, lightRoot };
  });
  expect(afterSheets.image).toContain('linear-gradient');
  expect(afterSheets.lightRoot).toBe('light');
  const silhouettes = new Map<string, string>();
  for (const variant of variants) {
    const result = await page.evaluate(
      ({ name, content }) => {
        document.documentElement.setAttribute('data-boot', name);
        const visible = [
          ...document.querySelectorAll<HTMLElement>('#boot-skeleton > .bs-variant'),
        ].filter((element) => getComputedStyle(element).display !== 'none');
        const selector = content[name] ?? '.bs-route-content';
        const measure = (root: HTMLElement) => {
          const target = root.querySelector<HTMLElement>(selector) ?? root;
          return {
            display: getComputedStyle(target).display,
            boxes: [...target.querySelectorAll<HTMLElement>('.bone')]
              .map((bone) => bone.getBoundingClientRect())
              .filter((box) => box.width > 0 && box.height > 0)
              .map(
                (box) =>
                  `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}`,
              ),
          };
        };
        const staticShape = visible[0] && measure(visible[0]);
        const blockDisplay = (block: string) =>
          visible[0]?.querySelector(block)
            ? getComputedStyle(visible[0].querySelector(block)!).display
            : 'absent';
        const blocks = {
          hero: blockDisplay('.bs-route-hero'),
          panel: blockDisplay('.bs-route-panel'),
          grid: blockDisplay('.bs-route-grid'),
          strip: blockDisplay('.bs-route-strip'),
        };
        // Cartão visível sem nenhum osso por dentro é uma caixa branca, não um esqueleto.
        const emptyCards = [
          ...(visible[0]?.querySelectorAll<HTMLElement>(
            '.bs-route-content .bs-pane, .bs-route-content .bs-route-sheet .bs-row, .bs-route-content .bs-route-row',
          ) ?? []),
        ].filter((card) => {
          const box = card.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) return false;
          return ![...card.querySelectorAll<HTMLElement>('.bone')].some((bone) => {
            const inner = bone.getBoundingClientRect();
            return inner.width > 0 && inner.height > 0;
          });
        }).length;
        const overlay = document.createElement('div');
        overlay.className = 'bs-root';
        overlay.setAttribute('data-boot-variant', name);
        if (visible[0]) overlay.append(visible[0].cloneNode(true));
        document.body.append(overlay);
        // O endereço inicial continua na Início quando o app navega; só o atributo do overlay sabe o novo destino.
        document.documentElement.setAttribute('data-boot', 'home');
        const angularShape =
          overlay.firstElementChild && measure(overlay.firstElementChild as HTMLElement);
        overlay.remove();
        return {
          visible: visible.length,
          emptyCards,
          staticShape,
          angularShape,
          blocks,
        };
      },
      { name: variant, content: namedContent },
    );
    expect(result.visible, variant).toBe(1);
    expect(result.emptyCards, `${variant}: cartão sem ossos`).toBe(0);
    // Blocos que a tela real não tem ficam escondidos: a folha crítica do index.html não pode reabri-los.
    for (const [block, shown] of Object.entries(hiddenBlocks[variant] ?? {})) {
      expect(result.blocks[block as keyof typeof result.blocks], `${variant} ${block}`).toBe(shown);
    }
    expect(result.staticShape?.display, variant).not.toBe('none');
    expect(result.staticShape?.boxes.length, variant).toBeGreaterThan(3);
    expect(result.angularShape?.boxes, variant).toEqual(result.staticShape?.boxes);
    if (!(variant in namedContent) && !['home', 'tv', 'settings'].includes(variant)) {
      const silhouette = result.staticShape!.boxes.join('|');
      expect([...silhouettes.values()], variant).not.toContain(silhouette);
      silhouettes.set(variant, silhouette);
    }
  }
});

test.describe('abertura da página de verdade', () => {
  // A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
  test.use({ serviceWorkers: 'block' });

  const MAIN_STYLES = /\/styles-[\w-]+\.css$/;

  test('o HTML entregue pinta o esqueleto sem esperar a folha de estilos e a CSP segue sem código em linha', async ({
    request,
  }) => {
    const response = await request.get('/');
    const csp = response.headers()['content-security-policy'];
    const served = await response.text();
    expect(csp).toContain("script-src 'self';");
    expect(served).toMatch(
      /<link rel="stylesheet" href="styles-[\w-]+\.css" media="print" data-boot-styles/,
    );
    expect(served).toContain('data-boot-critical');
    // Nenhum atributo de evento nem script em linha: a troca do media é feita pelo boot-skeleton.js.
    expect(served).not.toMatch(/\sonload=/);
    expect(served).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
  });

  test('o servidor já grava o desenho do endereço: o primeiro quadro de /tv e de /treino não passa pela Início', async ({
    page,
    request,
  }) => {
    expect(await (await request.get('/tv')).text()).toMatch(/<html[^>]* data-boot="tv"/);
    // Sem o script deferido (nem o app), só o que o HTML entregou pode ter escolhido o desenho.
    await page.route(/\/boot-skeleton\.js$/, (route) => route.abort());
    const expected = {
      '/tv': { variant: 'tv', shown: '.bs-tv' },
      '/tv/apps': { variant: 'tv', shown: '.bs-tv' },
      '/treino': { variant: 'training-today', shown: '.bs-training' },
      '/treino/rotinas': { variant: 'training-routines', shown: '.bs-training' },
      '/': { variant: 'home', shown: '.bs-home' },
    } as const;
    for (const [path, { variant, shown }] of Object.entries(expected)) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveAttribute('data-boot', variant);
      const visible = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('#boot-skeleton > .bs-variant')]
          .filter((el) => getComputedStyle(el).display !== 'none')
          .map((el) => el.className),
      );
      expect(visible, path).toHaveLength(1);
      expect(visible[0], path).toContain(shown.slice(1));
    }
  });

  test('com a folha de estilos presa, o esqueleto aparece pintado e cobre o app até a folha chegar', async ({
    context,
    page,
  }) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(MAIN_STYLES, async (route) => {
      await gate;
      await route.fallback();
    });

    await page.goto('/', { waitUntil: 'commit' });
    // O primeiro quadro com a folha ainda na rede: a forma dos ossos vem do próprio HTML.
    await page.locator('#boot-skeleton .bs-home .bone').first().waitFor({ state: 'visible' });
    const painted = await page.evaluate(() => {
      const bones = [...document.querySelectorAll<HTMLElement>('#boot-skeleton .bs-home .bone')];
      const sized = bones.filter((bone) => {
        const box = bone.getBoundingClientRect();
        return (
          box.width > 4 &&
          box.height > 4 &&
          (getComputedStyle(bone).backgroundColor !== 'rgba(0, 0, 0, 0)' ||
            getComputedStyle(bone).backgroundImage !== 'none')
        );
      });
      const root = document.getElementById('boot-skeleton')!;
      return {
        sized: sized.length,
        position: getComputedStyle(root).position,
        covering:
          document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('#boot-skeleton') !==
          null,
        styles: document.documentElement.getAttribute('data-styles'),
        media: document.querySelector<HTMLLinkElement>('link[data-boot-styles]')?.media,
      };
    });
    expect(painted.sized).toBeGreaterThan(4);
    expect(painted.position).toBe('fixed');
    expect(painted.covering).toBe(true);

    // O app sobe e chega ao conteúdo antes da folha: ele existe, mas a tela sem estilo nunca pode aparecer.
    await page.locator('app-root [data-screen-ready]').first().waitFor({ state: 'attached' });
    for (let frame = 0; frame < 5; frame++) {
      const covered = await page.evaluate(
        () =>
          new Promise<boolean[]>((resolve) =>
            requestAnimationFrame(() =>
              resolve(
                [0.1, 0.3, 0.5, 0.7, 0.9].flatMap((x) =>
                  [0.1, 0.4, 0.7, 0.95].map(
                    (y) =>
                      document
                        .elementFromPoint(innerWidth * x, innerHeight * y)
                        ?.closest('#boot-skeleton') !== null,
                  ),
                ),
              ),
            ),
          ),
      );
      expect(covered.every(Boolean)).toBe(true);
    }
    expect(await page.locator('#boot-skeleton.leaving').count()).toBe(0);
    expect(await page.locator('app-update-skeleton .bs-root').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-styles'))).toBe(
      'pending',
    );

    release();
    await expect(page.locator('html')).toHaveAttribute('data-styles', 'ready');
    await expect(page.locator('link[data-boot-styles]')).toHaveJSProperty('media', 'all');
    // Com a folha aplicada o esqueleto sai e a tela de verdade aparece estilizada (fundo e fonte do app).
    await expect(page.locator('#boot-skeleton')).toHaveCount(0);
    await expect(page.locator('app-root [data-screen-ready]').first()).toBeVisible();
    const body = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(body).toContain('system-ui');
  });

  test('com a folha carregada antes do script de abertura rodar, ela vale e o esqueleto sai', async ({
    context,
    page,
  }) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    let sheetLoaded!: () => void;
    const sheetDone = new Promise<void>((resolve) => (sheetLoaded = resolve));
    let releaseScript!: () => void;
    const scriptGate = new Promise<void>((resolve) => (releaseScript = resolve));
    page.on('requestfinished', (request) => {
      if (MAIN_STYLES.test(request.url())) sheetLoaded();
    });
    await page.route(/\/boot-skeleton\.js$/, async (route) => {
      await sheetDone;
      await scriptGate;
      await route.fallback();
    });

    await page.goto('/', { waitUntil: 'commit' });
    await sheetDone;
    // A folha já chegou (ainda com media="print") e o script que a liga não rodou: o esqueleto cobre sozinho. É a
    // abertura com o service worker, em que a folha vem do cache antes de o script de abertura executar.
    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector<HTMLLinkElement>('link[data-boot-styles]')?.sheet != null,
        ),
      )
      .toBe(true);
    // O HTML já nasce com a folha pendente e ninguém a assumiu ainda: nem o script nem o app rodaram.
    expect(
      await page.evaluate(() => [
        document.documentElement.getAttribute('data-styles'),
        document.documentElement.getAttribute('data-styles-owner'),
      ]),
    ).toEqual(['pending', null]);
    releaseScript();
    await expect(page.locator('html')).toHaveAttribute('data-styles', 'ready');
    await expect(page.locator('link[data-boot-styles]')).toHaveJSProperty('media', 'all');
    await expect(page.locator('#boot-skeleton')).toHaveCount(0);
    await expect(page.locator('app-root [data-screen-ready]').first()).toBeVisible();
  });

  test('com a folha de estilos fora do ar, o esqueleto fica e oferece tentar de novo em vez de mostrar a tela sem estilo', async ({
    context,
    page,
  }) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    // A falha chega depois de o script de abertura rodar (rede que cai no meio); se chegasse antes dele, o aviso sairia
    // pelo prazo de 20 s do próprio script.
    await page.route(MAIN_STYLES, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.abort();
    });
    await page.goto('/', { waitUntil: 'commit' });
    await expect(page.locator('#boot-timeout')).toBeVisible();
    await expect(page.locator('#boot-skeleton')).toHaveAttribute('data-boot-timeout', 'true');
    await page.locator('app-root [data-screen-ready]').first().waitFor({ state: 'attached' });
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-styles'))).toBe(
      'pending',
    );
    expect(await page.locator('#boot-skeleton.leaving').count()).toBe(0);
    expect(
      await page.evaluate(
        () =>
          document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('#boot-skeleton') !==
          null,
      ),
    ).toBe(true);
  });

  test('com a folha que falhou antes de o script de abertura rodar, o aviso sai logo e não só aos 20 s', async ({
    context,
    page,
  }) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    await page.route(MAIN_STYLES, (route) => route.abort());
    await page.goto('/', { waitUntil: 'commit' });
    // Chromium: o registro de recursos mostra a falha; WebKit: a folha vem vazia e sem regras legíveis.
    await expect(page.locator('#boot-timeout')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('#boot-skeleton')).toHaveAttribute('data-boot-timeout', 'true');
    expect(await page.locator('html').getAttribute('data-styles')).toBe('pending');
  });

  for (const [name, script] of [
    ['o script de abertura não carrega', null],
    [
      'o script de abertura em cache é de uma versão antiga, sem o cuidado com a folha',
      "document.documentElement.setAttribute('data-boot', 'home');",
    ],
  ] as const) {
    test(`quando ${name}, o app liga a folha de estilos sozinho e o esqueleto sai`, async ({
      context,
      page,
    }) => {
      const identity = await mockIdentityApi(context);
      identity.loggedIn = true;
      await page.route(/\/boot-skeleton\.js$/, (route) =>
        script === null
          ? route.abort()
          : route.fulfill({ contentType: 'text/javascript', body: script }),
      );
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-styles', 'ready');
      await expect(page.locator('html')).toHaveAttribute('data-styles-owner', 'app');
      await expect(page.locator('link[data-boot-styles]')).toHaveJSProperty('media', 'all');
      await expect(page.locator('#boot-skeleton')).toHaveCount(0);
      await expect(page.locator('app-root [data-screen-ready]').first()).toBeVisible();
      // O app aparece com o estilo dele, não cru.
      expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain(
        'system-ui',
      );
    });
  }

  test('na segunda abertura seguida sem a folha de estilos o app é liberado sem estilo, em vez de repetir o aviso', async ({
    context,
    page,
  }) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('uniover.boot-styles-failures'))
        sessionStorage.setItem('uniover.boot-styles-failures', '1');
    });
    await page.route(MAIN_STYLES, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.abort();
    });
    await page.goto('/', { waitUntil: 'commit' });
    await expect(page.locator('html')).toHaveAttribute('data-styles', 'ready', { timeout: 8_000 });
    await expect(page.locator('#boot-skeleton')).toHaveCount(0);
    await expect(page.locator('#boot-timeout')).toHaveCount(0);
    await expect(page.locator('app-root [data-screen-ready]').first()).toBeAttached();
  });

  test('com a folha rápida, o esqueleto sai assim que a tela fica pronta e a folha vale desde o início', async ({
    context,
    page,
  }) => {
    const identity = await mockIdentityApi(context);
    identity.loggedIn = true;
    await page.goto('/');
    await expect(page.locator('#boot-skeleton')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-styles', 'ready');
    await expect(page.locator('link[data-boot-styles]')).toHaveJSProperty('media', 'all');
    await expect(page.locator('app-root [data-screen-ready]').first()).toBeVisible();
  });
});
