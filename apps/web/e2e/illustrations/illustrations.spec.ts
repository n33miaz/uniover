import type { Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, waitForServiceWorkerControl } from '../fixtures';

// O servidor de teste entrega o mesmo `dist` que a imagem do Docker copia para o wwwroot.
const ART_DIR = join(__dirname, '..', '..', 'assets-third-party', 'everkinetic', 'svg');
// Os originais (SVG e PNG) não são publicados: o app serve a adaptação leve em WebP desta pasta.
const DERIVED_DIR = join(__dirname, '..', '..', 'assets-derived', 'everkinetic');
const OPEN_ART_DIR = join(__dirname, '..', '..', 'assets-derived', 'open-exercise-art');
const FIRST_POSE = '0042-relaxation.webp';
const SECOND_POSE = '0042-tension.webp';
const NOT_WARMED = '0043-relaxation.webp';

test.describe('ilustrações dos exercícios', () => {
  test.use({ serviceWorkers: 'block' });

  test('o build publica a figura em /exercise-art/ como WebP, idêntica à guardada', async ({
    request,
  }) => {
    const response = await request.get(`/exercise-art/${FIRST_POSE}`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('image/webp');
    expect(Buffer.compare(await response.body(), readFileSync(join(DERIVED_DIR, FIRST_POSE)))).toBe(
      0,
    );
  });

  test('todo arquivo de arte é publicado, idêntico ao guardado, e os originais não vão junto', async ({
    request,
  }) => {
    const files = readdirSync(DERIVED_DIR).filter((file) => file.endsWith('.webp'));
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      const response = await request.get(`/exercise-art/${file}`);
      expect(response.status(), file).toBe(200);
      expect(response.headers()['content-type']).toBe('image/webp');
      expect(
        Buffer.compare(await response.body(), readFileSync(join(DERIVED_DIR, file))),
        file,
      ).toBe(0);
    }
    // Os SVG originais ficam só no repositório: o app publica a adaptação.
    const original = readdirSync(ART_DIR)[0];
    const absent = await request.get(`/exercise-art/${original}`);
    expect(absent.headers()['content-type'] ?? '').not.toContain('image/svg+xml');
  });

  test('as figuras do Open Exercise Art são publicadas em /exercise-art/ idênticas às guardadas', async ({
    request,
  }) => {
    const files = readdirSync(OPEN_ART_DIR).filter((file) => file.endsWith('.webp'));
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const response = await request.get(`/exercise-art/${file}`);
      expect(response.status(), file).toBe(200);
      expect(response.headers()['content-type']).toBe('image/webp');
      expect(
        Buffer.compare(await response.body(), readFileSync(join(OPEN_ART_DIR, file))),
        file,
      ).toBe(0);
    }
    // Os SVG originais não vão junto.
    const absent = await request.get('/exercise-art/plank.svg');
    expect(absent.headers()['content-type'] ?? '').not.toContain('image/svg+xml');
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

  test('os pares carregam em 536x550, os de origem SVG e os de origem PNG', async ({ page }) => {
    await page.goto('/entrar');
    const sizes = await page.evaluate(
      (files) =>
        Promise.all(
          files.map(
            (file) =>
              new Promise<{ file: string; width: number; height: number }>((resolve, reject) => {
                const img = document.createElement('img');
                img.addEventListener('load', () =>
                  resolve({ file, width: img.naturalWidth, height: img.naturalHeight }),
                );
                img.addEventListener('error', () => reject(new Error(`não carregou: ${file}`)));
                img.src = `/exercise-art/${file}`;
                document.body.append(img);
              }),
          ),
        ),
      [
        'chin-ups-1.webp',
        'chin-ups-2.webp',
        'standing-one-arm-triceps-extension-with-dumbbell-1.webp',
        '0113-relaxation.webp',
        '0123-tension.webp',
        'oea-plank.webp',
        'oea-leg-press-calf-raise.webp',
      ],
    );
    for (const size of sizes) {
      expect([size.width, size.height], size.file).toEqual([536, 550]);
    }
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
    expect(await fetchStatus(page, FIRST_POSE)).toEqual({ status: 200, type: 'image/webp' });
    expect(await fetchStatus(page, SECOND_POSE)).toEqual({ status: 200, type: 'image/webp' });
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
      expect(await fetchStatus(page, FIRST_POSE)).toEqual({ status: 200, type: 'image/webp' });
      expect(await fetchStatus(page, SECOND_POSE)).toEqual({ status: 200, type: 'image/webp' });
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
