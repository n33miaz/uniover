// Gera os .ico da bandeja do Windows a partir dos SVGs de apps/agent/assets/tray (sharp, o mesmo do app web).
// Os .ico são versionados: o agente instalado não depende de Node, e rodar este script de novo sem mexer nos SVGs não
// altera nenhum arquivo. Uso: node apps/agent/tools/build_tray_icons.mjs [pasta-de-previas-png]
//
// Cada estado gera dois arquivos (`<estado>.ico` e `<estado>-attention.ico`, com o selo de atenção), e cada .ico leva
// as oito resoluções que o Windows pede nas escalas de 100% a 400% (16, 20, 24, 32, 40, 48, 64 e 256 px). 16, 20 e 24
// têm desenho próprio na grade do pixel (uma unidade do SVG é um pixel) e entram sem reamostrar; as demais saem do
// desenho mestre de 64. O agente carrega o .ico no tamanho exato da bandeja, então nenhuma escala acontece depois.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const sharp = require('sharp');

const assets = fileURLToPath(new URL('../assets/tray/', import.meta.url));
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const GRID = new Map([
  [16, 'tray-16.svg'],
  [20, 'tray-20.svg'],
  [24, 'tray-24.svg'],
]);
const MASTER = 'tray-64.svg';
// A cor com que os SVGs vêm desenhados (estado "conectado"); cada estado troca só o disco.
const BASE_DISC = '#1F8A4C';
const STATES = {
  connected: '#1F8A4C',
  reconnecting: '#C26A00',
  error: '#B71C1C',
  updating: '#1F6FD1',
};

const ATTENTION = /\s*<g id="attention">[\s\S]*?<\/g>\n?/;

function variant(svg, color, attention) {
  let out = svg.replaceAll(BASE_DISC, color);
  if (!attention) out = out.replace(ATTENTION, '\n');
  return out;
}

async function frame(svg, size) {
  // Grade: uma unidade = um pixel (densidade 72); mestre: densidade proporcional ao tamanho pedido.
  const density = GRID.has(size) ? 72 : (72 * size) / 64;
  const png = await sharp(Buffer.from(svg), { density }).ensureAlpha().png({ compressionLevel: 9 }).toBuffer();
  const { width, height } = await sharp(png).metadata();
  if (width !== size || height !== size) {
    throw new Error(`o desenho de ${size} px saiu com ${width}x${height}`);
  }
  return png;
}

function pack(frames) {
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, png }, index) => {
    const at = 6 + 16 * index;
    header.writeUInt8(size === 256 ? 0 : size, at);
    header.writeUInt8(size === 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...frames.map(({ png }) => png)]);
}

const sources = new Map();
for (const file of [MASTER, ...GRID.values()]) {
  sources.set(file, await readFile(join(assets, file), 'utf8'));
}
const previews = process.argv[2];
if (previews) await mkdir(previews, { recursive: true });

for (const [state, color] of Object.entries(STATES)) {
  for (const attention of [false, true]) {
    const name = attention ? `${state}-attention` : state;
    const frames = [];
    for (const size of SIZES) {
      const svg = variant(sources.get(GRID.get(size) ?? MASTER), color, attention);
      const png = await frame(svg, size);
      frames.push({ size, png });
      if (previews) await writeFile(join(previews, `${name}-${size}.png`), png);
    }
    await writeFile(join(assets, `${name}.ico`), pack(frames));
    console.log(`[tray] ${name}.ico`);
  }
}
