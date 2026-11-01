// Rasteriza os SVG do Open Exercise Art (assets-third-party/open-exercise-art/svg) para PNG grandes, preto sobre branco,
// primeira etapa da adaptação que `optimize-open-art.py` termina (enquadramento, 536x550, WebP). Os SVG originais não
// são alterados: o desenho usa `currentColor` (tinta preta por padrão) e aqui só se fixa o preto para rasterizar.
//
// Uso (a partir de apps/web), com um Chromium do Playwright instalado:
//   node scripts/render-open-art.mjs <pasta de saída>
// Depois:
//   python -I scripts/optimize-open-art.py <pasta de saída>
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const SOURCE = resolve(import.meta.dirname, '..', 'assets-third-party', 'open-exercise-art', 'svg');
const out = process.argv[2];
if (!out) {
  console.error('uso: node scripts/render-open-art.mjs <pasta de saída>');
  process.exit(1);
}
mkdirSync(out, { recursive: true });

// Lado maior da imagem rasterizada: sobra resolução para reduzir a 536x550 sem serrilhado.
const LONG_SIDE = 1600;

const browser = await chromium.launch();
const context = await browser.newContext({
  deviceScaleFactor: 1,
  viewport: { width: 1800, height: 1800 },
});
const page = await context.newPage();
const holder = join(out, 'holder.html');
try {
  for (const file of readdirSync(SOURCE)
    .filter((name) => name.endsWith('.svg'))
    .sort()) {
    const target = join(out, file.replace(/\.svg$/, '.png'));
    // Retomável: o que já foi rasterizado numa rodada interrompida não se refaz.
    if (existsSync(target)) continue;
    const text = readFileSync(join(SOURCE, file), 'utf8');
    const box = /viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/.exec(text.slice(0, 400));
    if (!box) throw new Error(`${file}: sem viewBox`);
    const [width, height] = [Number(box[1]), Number(box[2])];
    const scale = LONG_SIDE / Math.max(width, height);
    // O SVG fica dentro de uma <img> (CSP e comportamento iguais aos do app); a tinta é fixada em preto num arquivo de
    // apoio, sem tocar no original.
    const black = join(out, `_${createHash('sha1').update(file).digest('hex')}.svg`);
    writeFileSync(black, text.replaceAll('currentColor', '#000'));
    writeFileSync(
      holder,
      `<body style="margin:0;background:#fff"><img id="art" width="${Math.round(width * scale)}" height="${Math.round(height * scale)}" src="${pathToFileURL(black).href}">`,
    );
    await page.goto(pathToFileURL(holder).href);
    await page.locator('#art').screenshot({ path: target, timeout: 120_000 });
    rmSync(black, { force: true });
  }
} finally {
  await browser.close();
  rmSync(holder, { force: true });
}
