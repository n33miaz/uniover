// Gera os PNGs dos ícones a partir dos SVGs de apps/web/design/icons (sharp). Os PNGs são versionados: o build
// do app não depende do sharp, e rodar este script de novo sem mexer nos SVGs não altera nenhum arquivo.
// Uso: node scripts/build-icons.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const designDir = join(webRoot, 'design', 'icons');
const publicDir = join(webRoot, 'public');

// Mesma cor de fundo dos SVGs; só serve para achatar o PNG em RGB, sem canal alfa.
const BRAND = '#3B6B4B';

// Início na raiz de public/ e um conjunto por módulo (o `id` e o `scope` de cada um vêm dos manifests).
const SETS = [
  { svg: 'core', dir: '' },
  { svg: 'tv', dir: 'tv' },
  { svg: 'treino', dir: 'treino' },
];

async function render(file, size, { opaque }) {
  const svg = await readFile(join(designDir, file));
  // A densidade alta evita serrilhado ao reduzir; o resultado é o mesmo em toda máquina com o mesmo sharp.
  let image = sharp(svg, { density: 384 }).resize(size, size);
  // Fundo opaco e sem canal alfa: o iOS aplica a própria máscara e não aceita transparência no ícone.
  if (opaque) image = image.flatten({ background: BRAND }).removeAlpha();
  return image.png({ compressionLevel: 9, palette: false }).toBuffer();
}

async function write(path, buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
  console.log(`[icons] ${relative(publicDir, path).split(sep).join('/')}`);
}

for (const { svg, dir } of SETS) {
  const out = (name) => join(publicDir, dir, name);
  await write(out('apple-touch-icon.png'), await render(`${svg}.svg`, 180, { opaque: true }));
  for (const size of [192, 512]) {
    await write(out(`icons/icon-${size}.png`), await render(`${svg}.svg`, size, { opaque: true }));
    await write(
      out(`icons/maskable-${size}.png`),
      await render(`${svg}-maskable.svg`, size, { opaque: true }),
    );
  }
  await write(
    out('icons/monochrome-512.png'),
    await render(`${svg}-mono.svg`, 512, { opaque: false }),
  );
}

// Favicon só na raiz: a versão para tamanhos pequenos (ponto maior, uma onda por lado).
await write(join(publicDir, 'favicon.svg'), await readFile(join(designDir, 'core-small.svg')));
await write(
  join(publicDir, 'favicon-32.png'),
  await render('core-small.svg', 32, { opaque: false }),
);
