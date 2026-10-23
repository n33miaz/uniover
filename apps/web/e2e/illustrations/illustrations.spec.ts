import type { Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, waitForServiceWorkerControl } from '../fixtures';

// O servidor de teste entrega o mesmo `dist` que a imagem do Docker copia para o wwwroot.
const ART_DIR = join(__dirname, '..', '..', 'assets-third-party', 'everkinetic', 'svg');
const PNG_DIR = join(__dirname, '..', '..', 'assets-third-party', 'everkinetic', 'png');
const FIRST_POSE = '0042-relaxation.svg';
const SECOND_POSE = '0042-tension.svg';
const NOT_WARMED = '0043-relaxation.svg';

test.describe('ilustrações dos exercícios', () => {
  test.use({ serviceWorkers: 'block' });

  test('o build publica o arquivo original em /exercise-art/ como SVG', async ({ request }) => {
    const response = await request.get(`/exercise-art/${FIRST_POSE}`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('image/svg+xml');
    expect(Buffer.compare(await response.body(), readFileSync(join(ART_DIR, FIRST_POSE)))).toBe(0);
  });

  test('todo arquivo guardado é publicado, idêntico ao original', async ({ request }) => {
    const files = [
      ...readdirSync(ART_DIR).map((file) => ({ file, path: join(ART_DIR, file) })),
      ...readdirSync(PNG_DIR).map((file) => ({ file, path: join(PNG_DIR, file) })),
    ];
    expect(files.length).toBeGreaterThan(100);
    for (const { file, path } of files) {
      const response = await request.get(`/exercise-art/${file}`);
      expect(response.status(), file).toBe(200);
      if (file.endsWith('.png')) expect(response.headers()['content-type']).toBe('image/png');
      expect(Buffer.compare(await response.body(), readFileSync(path)), file).toBe(0);
    }
  });

  test('um <img> da mesma origem com a arte carrega sem violar a CSP', async ({ page }) => {
    await page.goto('/entrar');
    const loaded = await page.evaluate(
      (file) =>
        new Promise<{ width: number; height: number }>((resolve, reject) => {
          const img = document.createElement('img');
          img.alt = 'teste';
          img.addEventListener('load', () =>
            resolve({ width: img.naturalWidth, height: img.naturalHeight }),
          );
          img.addEventListener('error', () => reject(new Error('a imagem não carregou')));
          img.src = `/exercise-art/${file}`;
          document.body.append(img);
        }),
      FIRST_POSE,
    );
    expect(loaded.width).toBeGreaterThan(0);
    expect(loaded.height).toBeGreaterThan(0);
    // A violação de CSP (se houvesse) derruba o teste pela fixture.
  });

  test('uma imagem de outra origem continua bloqueada pela CSP (a prova mede de verdade)', async ({
    page,
    cspViolations,
  }) => {
    await page.route('https://exemplo-fora.test/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      }),
    );
    await page.goto('/entrar');
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const img = document.createElement('img');
          img.addEventListener('load', () => resolve());
          img.addEventListener('error', () => resolve());
          img.src = 'https://exemplo-fora.test/a.svg';
          document.body.append(img);
        }),
    );
    await expect.poll(() => cspViolations.length).toBeGreaterThan(0);
    cspViolations.length = 0; // esperado: não deve derrubar o teste
  });

  test('o service worker tem a rota de execução da arte e não a lista no precache', async ({
    request,
  }) => {
    const response = await request.get('/sw.js');
    expect(response.ok()).toBe(true);
    const worker = await response.text();
    expect(worker).toContain('/exercise-art/');
    // O precache lista os arquivos com `url:"..."`; nenhum deles é da pasta da arte.
    expect(worker).not.toMatch(/url:\s*["'`]\/?exercise-art\//);
    expect(worker).not.toMatch(/["'`]exercise-art\/\d{4}-/);
  });

  test('a pasta guardada tem só pares completos de arquivos SVG', () => {
    const files = readdirSync(ART_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => /^\d{4}-(relaxation|tension)\.svg$/.test(file))).toBe(true);
    const ids = new Set(files.map((file) => file.slice(0, 4)));
    for (const id of ids) {
      expect(files).toContain(`${id}-relaxation.svg`);
      expect(files).toContain(`${id}-tension.svg`);
    }
  });
});

test.describe('ilustrações guardadas pelo service worker', () => {
  test.use({ serviceWorkers: 'allow' });

  const fetchStatus = (page: Page, file: string) =>
    page.evaluate(async (name) => {
      try {
        const response = await fetch(`/exercise-art/${name}`);
        return { status: response.status, type: response.headers.get('content-type') };
      } catch {
        return { status: 0, type: null };
      }
    }, file);

  test('depois de aquecidas com rede, as ilustrações carregam sem rede; as outras não', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await waitForServiceWorkerControl(page);

    // Aquecer = buscar os dois quadros na mesma origem com rede (o que o `warm` faz); o worker os guarda.
    expect(await fetchStatus(page, FIRST_POSE)).toEqual({ status: 200, type: 'image/svg+xml' });
    expect(await fetchStatus(page, SECOND_POSE)).toEqual({ status: 200, type: 'image/svg+xml' });
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const cache = await caches.open('exercise-art');
          return (await cache.keys()).map((request) => new URL(request.url).pathname).sort();
        }),
      )
      .toEqual([`/exercise-art/${FIRST_POSE}`, `/exercise-art/${SECOND_POSE}`]);

    // A arte fica só no cache de execução; o precache da casca não leva nenhum arquivo dela.
    const elsewhere = await page.evaluate(async () => {
      const found: string[] = [];
      for (const name of await caches.keys()) {
        if (name === 'exercise-art') continue;
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          if (request.url.includes('/exercise-art/')) found.push(`${name} ${request.url}`);
        }
      }
      return found;
    });
    expect(elsewhere).toEqual([]);

    await context.setOffline(true);
    try {
      // Sem rede: o que foi aquecido vem do cache, com o tipo certo.
      expect(await fetchStatus(page, FIRST_POSE)).toEqual({ status: 200, type: 'image/svg+xml' });
      expect(await fetchStatus(page, SECOND_POSE)).toEqual({ status: 200, type: 'image/svg+xml' });
      const drawn = await page.evaluate(
        (file) =>
          new Promise<number>((resolve) => {
            const img = document.createElement('img');
            img.alt = 'teste';
            img.addEventListener('load', () => resolve(img.naturalWidth));
            img.addEventListener('error', () => resolve(0));
            img.src = `/exercise-art/${file}`;
            document.body.append(img);
          }),
        FIRST_POSE,
      );
      expect(drawn).toBeGreaterThan(0);
      // O que nunca foi visto não existe sem rede (prova de que as respostas acima vieram do cache).
      expect((await fetchStatus(page, NOT_WARMED)).status).toBe(0);
    } finally {
      await context.setOffline(false);
    }
  });
});
