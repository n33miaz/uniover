import { crc32, deflateSync } from 'node:zlib';

/**
 * Ícones de mentira para os testes: PNGs de verdade, desenhados aqui pixel a pixel (nenhum vem de app real). Servem para
 * conferir como a tela trata um ícone quadrado, um banner 16:9 (o CineVS chega assim da TV), um ícone com fundo
 * transparente e um que não carrega.
 */

type Rgba = readonly [number, number, number, number];
type Shader = (x: number, y: number) => Rgba;

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

/** Codifica uma imagem RGBA de 8 bits por canal; `shade` devolve a cor do pixel (x, y). */
export function encodePng(width: number, height: number, shade: Shader): Buffer {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const start = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = shade(x, y);
      rows.set(
        [r, g, b, a].map((v) => Math.round(Math.min(255, Math.max(0, v)))),
        start + 1 + x * 4,
      );
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const toDataUri = (png: Buffer, mime = 'image/png') =>
  `data:${mime};base64,${png.toString('base64')}`;

/** Cobertura (0 a 1) de uma forma pela distância assinada até a borda: contorno suave, sem serrilhado. */
const cover = (distance: number) => Math.min(1, Math.max(0, 0.5 - distance));

function roundedRect(
  x: number,
  y: number,
  left: number,
  top: number,
  w: number,
  h: number,
  r: number,
) {
  const dx = Math.abs(x - (left + w / 2)) - (w / 2 - r);
  const dy = Math.abs(y - (top + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}

/** Põe `color` por cima de `base` com a cobertura dada. */
function over(base: Rgba, color: readonly [number, number, number], coverage: number): Rgba {
  const alpha = coverage + (base[3] / 255) * (1 - coverage);
  if (alpha === 0) return [0, 0, 0, 0];
  const mix = (i: number) =>
    (color[i] * coverage + base[i] * (base[3] / 255) * (1 - coverage)) / alpha;
  return [mix(0), mix(1), mix(2), alpha * 255];
}

/** Ícone quadrado e opaco: quadrado arredondado em degradê com um botão de reproduzir. */
export function squareIcon(size = 96): Buffer {
  return encodePng(size, size, (x, y) => {
    const t = (x + y) / (2 * size);
    const base: Rgba = [
      31 + 27 * t,
      122 - 32 * t,
      140 + 15 * t,
      255 * cover(roundedRect(x, y, 0, 0, size, size, size * 0.22)),
    ];
    const disc = Math.hypot(x - size / 2, y - size / 2) - size * 0.27;
    const withDisc = over(base, [255, 255, 255], cover(disc) * (base[3] / 255));
    const inTriangle =
      x > size * 0.44 && x < size * 0.64 && Math.abs(y - size / 2) < (size * 0.64 - x) * 0.9;
    return inTriangle ? over(withDisc, [40, 90, 140], 1) : withDisc;
  });
}

/** Ícone com fundo transparente e desenho escuro: some em qualquer fundo escuro que não seja claro por baixo. */
export function transparentIcon(size = 96): Buffer {
  return encodePng(size, size, (x, y) => {
    const radius = Math.hypot(x - size / 2, y - size / 2);
    const ring = Math.abs(radius - size * 0.32) - size * 0.1;
    const dot = radius - size * 0.1;
    return over([0, 0, 0, 0], [38, 44, 50], cover(Math.min(ring, dot)));
  });
}

/** Banner 16:9 em fundo preto, como o do CineVS: um logotipo de barras brancas e um ponto vermelho. */
export function bannerIcon(width = 320, height = 180): Buffer {
  return encodePng(width, height, (x, y) => {
    let color: Rgba = [0, 0, 0, 255];
    const bars: [number, number][] = [
      [60, 70],
      [84, 100],
      [108, 80],
      [132, 100],
      [156, 70],
    ];
    for (const [left, h] of bars) {
      const d = roundedRect(x, y, left, (height - h) / 2, 14, h, 6);
      color = over(color, [245, 245, 245], cover(d));
    }
    const dot = Math.hypot(x - 230, y - height / 2) - 22;
    return over(color, [214, 48, 49], cover(dot));
  });
}

/** Ruído de pixel (incompressível): um PNG que chega perto do teto de 32 KB da API, ~44 mil caracteres em base64. */
export function noisyIcon(seed: number, side = 90): Buffer {
  let state = (seed * 2654435761) >>> 0 || 1;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
  return encodePng(side, side, () => [next(), next(), next(), next()]);
}

/** Um WebP sem perdas de 1x1 pixel (o menor possível): só prova que o navegador lê o formato. */
export const TINY_WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

/** Diz ser PNG, mas os bytes são lixo: a imagem dispara `error` ao carregar. */
export const BROKEN_PNG = 'data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAA';

export const ICONS = {
  square: toDataUri(squareIcon()),
  transparent: toDataUri(transparentIcon()),
  banner: toDataUri(bannerIcon()),
};
