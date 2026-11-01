// Rasteriza os SVG originais do Everkinetic para PNG grandes (fundo branco), primeira etapa da adaptação que
// `optimize-exercise-art.py` termina (recorte, 536x550, WebP). Os SVG originais não são alterados.
//
// Uso (a partir de apps/web), com um Chromium do Playwright instalado:
//   node scripts/render-exercise-svg.mjs <pasta de saída> [NNNN ...]   (sem números, todos os pares)
// Depois:
//   python -I scripts/optimize-exercise-art.py <pasta de saída>
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const SOURCE = resolve(import.meta.dirname, '..', 'assets-third-party', 'everkinetic', 'svg');
const [out, ...only] = process.argv.slice(2);
if (!out) {
  console.error('uso: node scripts/render-exercise-svg.mjs <pasta de saída>');
  process.exit(1);
}
mkdirSync(out, { recursive: true });

// 3x o tamanho de tela: sobra resolução para reduzir a 536x550 sem serrilhado.
// Tamanho em pixels de CSS de cada unidade do viewBox. Os atributos width/height dos arquivos vêm em unidades
// diferentes (pt, px, ou sem relação com o viewBox) e dariam escalas diferentes às duas poses de um mesmo exercício;
// o viewBox é o que as duas poses compartilham.
const UNIT = 1.5;

// O SVG vai dentro de uma página com <img>: o Chromium rasteriza na caixa natural (width/height do arquivo) e o
// recorte pelo elemento evita a página inteira em branco ao redor.
const browser = await chromium.launch();
const context = await browser.newContext({
  deviceScaleFactor: 3,
  viewport: { width: 400, height: 400 },
});
const page = await context.newPage();
const holder = join(out, 'holder.html');
try {
  for (const file of readdirSync(SOURCE)
    .filter(
      (name) => name.endsWith('.svg') && (only.length === 0 || only.includes(name.slice(0, 4))),
    )
    .sort()) {
    const target = join(out, file.replace(/\.svg$/, '.png'));
    // Retomável: o que já foi rasterizado numa rodada interrompida não se refaz.
    if (existsSync(target)) continue;
    const box = /viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/.exec(
      readFileSync(join(SOURCE, file), 'utf8').slice(0, 400),
    );
    if (!box) throw new Error(`${file}: sem viewBox`);
    const [width, height] = [Number(box[1]) * UNIT, Number(box[2]) * UNIT];
    writeFileSync(
      holder,
      `<body style="margin:0;background:#fff"><img id="art" width="${width}" height="${height}" src="${pathToFileURL(join(SOURCE, file)).href}">`,
    );
    await page.goto(pathToFileURL(holder).href);
    await page.locator('#art').screenshot({ path: target, timeout: 120_000 });
  }
} finally {
  await browser.close();
  rmSync(holder, { force: true });
}
