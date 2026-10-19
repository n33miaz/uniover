// Gera o service worker depois do build do Angular: empacota src/sw.ts e injeta a lista de arquivos da casca
// (workbox-build, injectManifest). Roda sobre dist/web/browser, que é o que a imagem copia para o wwwroot.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { injectManifest } from 'workbox-build';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(webRoot, 'dist', 'web', 'browser');
const tmp = await mkdtemp(join(tmpdir(), 'uniover-sw-'));

try {
  // A lista de módulos com escopo vem do mesmo arquivo que o service worker usa.
  const slugsFile = join(tmp, 'module-slugs.mjs');
  await build({
    entryPoints: [join(webRoot, 'src', 'app', 'core', 'modules', 'module-slugs.ts')],
    outfile: slugsFile,
    format: 'esm',
    logLevel: 'silent',
  });
  const { SCOPED_MODULE_SLUGS } = await import(pathToFileURL(slugsFile).href);

  const bundled = join(tmp, 'sw.js');
  await build({
    entryPoints: [join(webRoot, 'src', 'sw.ts')],
    outfile: bundled,
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2022',
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  // As páginas são servidas pela API (com o manifest do módulo e o nonce trocados), então o worker as busca
  // na instalação. O index.html cru do dist não entra no precache; ele só serve para calcular a revisão.
  const indexHtml = await readFile(join(distDir, 'index.html'));
  const revision = createHash('sha256').update(indexHtml).digest('hex').slice(0, 16);
  const pages = ['/', ...SCOPED_MODULE_SLUGS.map((slug) => `/${slug}/`)];

  const result = await injectManifest({
    swSrc: bundled,
    swDest: join(distDir, 'sw.js'),
    globDirectory: distDir,
    globPatterns: ['**/*.{js,css,woff2,woff,ico,png,svg,webmanifest,json}'],
    globIgnores: ['**/index.html', '**/*.map', '**/3rdpartylicenses.txt', 'sw.js'],
    additionalManifestEntries: pages.map((url) => ({ url, revision })),
    maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
  });

  for (const warning of result.warnings) console.warn(`[sw] ${warning}`);
  const size = (await stat(join(distDir, 'sw.js'))).size;
  console.log(
    `[sw] sw.js gerado: ${result.count} arquivos no precache (${(result.size / 1024).toFixed(1)} kB), ` +
      `${(size / 1024).toFixed(1)} kB, páginas: ${pages.join(' ')}`,
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
