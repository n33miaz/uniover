import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { expect, expectNoHorizontalScroll, test, waitForServiceWorkerControl } from '../fixtures';

const publicDir = join(__dirname, '..', '..', 'public');

interface ManifestIcon {
  src: string;
}
interface Manifest {
  id: string;
  icons: ManifestIcon[];
}

const SCOPES = [
  { page: '/', manifest: '/manifest.webmanifest', touch: '/apple-touch-icon.png' },
  { page: '/tv/', manifest: '/tv/manifest.webmanifest', touch: '/tv/apple-touch-icon.png' },
  {
    page: '/treino/',
    manifest: '/treino/manifest.webmanifest',
    touch: '/treino/apple-touch-icon.png',
  },
];

test.describe('manifest por módulo', () => {
  for (const scope of SCOPES) {
    test(`GET ${scope.page} traz um único manifest e o ícone do escopo`, async ({ request }) => {
      const html = await (await request.get(scope.page)).text();
      expect(html.match(/<link rel="manifest"[^>]*>/g)).toEqual([
        `<link rel="manifest" href="${scope.manifest}">`,
      ]);
      expect(html.match(/<link rel="apple-touch-icon"[^>]*>/g)).toEqual([
        `<link rel="apple-touch-icon" href="${scope.touch}">`,
      ]);
    });

    test(`${scope.manifest} é servido como manifest e todos os ícones respondem 200`, async ({
      request,
    }) => {
      const response = await request.get(scope.manifest);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('application/manifest+json');
      const manifest = (await response.json()) as Manifest;
      expect(manifest.id).toBe(scope.page);
      for (const url of [...manifest.icons.map((icon) => icon.src), scope.touch]) {
        const icon = await request.get(url);
        expect(icon.status(), url).toBe(200);
        expect(icon.headers()['content-type'], url).toBe('image/png');
      }
    });
  }

  test('favicon do Início responde 200', async ({ request }) => {
    for (const url of ['/favicon.svg', '/favicon-32.png']) {
      expect((await request.get(url)).status(), url).toBe(200);
    }
  });

  test('os manifests em disco são os que o servidor entrega', async ({ request }) => {
    for (const scope of SCOPES) {
      const onDisk = readFileSync(`${publicDir}${scope.manifest}`, 'utf8');
      expect(await (await request.get(scope.manifest)).text()).toBe(onDisk);
    }
  });

  test('com o service worker no controle, /tv/ e / mantêm o manifest do escopo, online e offline', async ({
    page,
    context,
  }) => {
    await page.goto('/tv/');
    await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
    await waitForServiceWorkerControl(page);

    const manifestHrefs = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('link[rel="manifest"]')).map((link) =>
          link.getAttribute('href'),
        ),
      );

    for (const offline of [false, true]) {
      await context.setOffline(offline);
      await page.goto('/tv/');
      await expect(page.getByRole('heading', { level: 1, name: 'TV' })).toBeVisible();
      expect(await manifestHrefs(), `/tv/ offline=${offline}`).toEqual([
        '/tv/manifest.webmanifest',
      ]);
      await expectNoHorizontalScroll(page);

      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        /Bom dia|Boa tarde|Boa noite/,
      );
      expect(await manifestHrefs(), `/ offline=${offline}`).toEqual(['/manifest.webmanifest']);
    }
    await context.setOffline(false);
  });

  test('com o service worker no controle, /treino/?instalar=... carrega a casca e o manifest do Treino, online e offline, e o endereço fica limpo', async ({
    page,
    context,
  }) => {
    await page.goto('/treino/');
    await waitForServiceWorkerControl(page);

    for (const offline of [false, true]) {
      await context.setOffline(offline);
      // Um código qualquer: sem o que o botão grava na sessão a folha não abre, mas a carga e a limpeza do endereço valem.
      await page.goto('/treino/?instalar=codigo-de-teste&x=1');
      await expect(page.locator('app-root')).toBeAttached();
      await expect
        .poll(() => page.evaluate(() => location.search), { message: `offline=${offline}` })
        .toBe('?x=1');
      await expect(page.locator('head link[rel="manifest"]'), `offline=${offline}`).toHaveAttribute(
        'href',
        '/treino/manifest.webmanifest',
      );
      const manifest = await page.evaluate(async () => {
        const response = await fetch('/treino/manifest.webmanifest');
        return { status: response.status, id: ((await response.json()) as { id: string }).id };
      });
      expect(manifest, `manifest offline=${offline}`).toEqual({ status: 200, id: '/treino/' });
      await expectNoHorizontalScroll(page);
    }
    await context.setOffline(false);
  });

  test('o Chromium não aponta erro de instalabilidade em / e /tv/', async ({
    baseURL,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Page.getInstallabilityErrors só existe no Chromium');
    // O headless "shell" do Playwright devolve sempre lista vazia; o Chromium completo (channel
    // 'chromium') calcula de verdade. Um contexto novo é anônimo, então esse aviso é ignorado.
    const browser = await chromium.launch({ channel: 'chromium' });
    try {
      const page = await browser.newPage();
      const session = await page.context().newCDPSession(page);
      await session.send('Page.enable');
      const errors = async (url: string) => {
        await page.goto(url);
        await page.waitForTimeout(1500);
        const result = (await session.send('Page.getInstallabilityErrors')) as {
          installabilityErrors: { errorId: string }[];
        };
        return result.installabilityErrors
          .map((e) => e.errorId)
          .filter((id) => id !== 'in-incognito');
      };

      // Controle negativo: sem manifest o Chromium precisa reclamar, senão a sonda não prova nada.
      await page.route(`${baseURL}/sem-manifest`, (route) =>
        route.fulfill({ contentType: 'text/html', body: '<title>x</title><p>oi</p>' }),
      );
      expect(await errors(`${baseURL}/sem-manifest`)).toContain('no-manifest');

      for (const path of ['/', '/tv/']) {
        expect(await errors(`${baseURL}${path}`), path).toEqual([]);
      }
    } finally {
      await browser.close();
    }
  });
});
