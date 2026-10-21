import { ICONS, encodePng, toDataUri } from './synthetic-icons';

/**
 * Ícones de mentira para provar o ajuste do ícone ao azulejo: cada um repete um jeito real de um app trazer margem
 * própria (transparente com sombra, branca, de cor chapada) ou de não trazer nenhuma. Desenhados aqui pixel a pixel;
 * nada vem de um app de verdade.
 */

type Rgba = readonly [number, number, number, number];

const cover = (distance: number) => Math.min(1, Math.max(0, 0.5 - distance));

/** Distância assinada até um retângulo de cantos arredondados (negativa por dentro). */
function roundedRect(
  x: number,
  y: number,
  left: number,
  top: number,
  size: number,
  radius: number,
): number {
  const dx = Math.abs(x - (left + size / 2)) - (size / 2 - radius);
  const dy = Math.abs(y - (top + size / 2)) - (size / 2 - radius);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Distância até uma linha quebrada. */
function polyline(x: number, y: number, points: readonly [number, number][]): number {
  let best = Infinity;
  for (let index = 1; index < points.length; index++) {
    const [ax, ay] = points[index - 1];
    const [bx, by] = points[index];
    const t = Math.min(
      1,
      Math.max(
        0,
        ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2),
      ),
    );
    best = Math.min(best, Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))));
  }
  return best;
}

/** Põe `color` por cima de `base` com a cobertura dada (alfa reto na saída). */
function over(base: Rgba, color: readonly [number, number, number], coverage: number): Rgba {
  const baseAlpha = base[3] / 255;
  const alpha = coverage + baseAlpha * (1 - coverage);
  if (alpha === 0) return [0, 0, 0, 0];
  const mix = (i: number) => (color[i] * coverage + base[i] * baseAlpha * (1 - coverage)) / alpha;
  return [mix(0), mix(1), mix(2), alpha * 255];
}

/** Como o do CineVS: placa preta de cantos arredondados, "VS" azul, margem transparente de 10% e sombra suave. */
export function cinevsLikeIcon(size = 192): Buffer {
  const margin = size * 0.1;
  const plate = size - 2 * margin;
  const radius = plate * 0.13;
  const k = size / 192;
  return encodePng(size, size, (x, y) => {
    // A sombra é baixa e suave (alfa máximo perto de 25%): sai um pouco da placa, mais embaixo.
    const shadowDistance = roundedRect(x, y - 5 * k, margin, margin, plate, radius);
    const shadowAlpha = Math.max(0, 1 - Math.max(shadowDistance, 0) / (9 * k)) * 0.25;
    let color: Rgba = [0, 0, 0, shadowAlpha * 255];
    color = over(color, [12, 12, 12], cover(roundedRect(x, y, margin, margin, plate, radius)));
    const blue: [number, number, number] = [22, 150, 215];
    const v = polyline(x, y, [
      [52 * k, 70 * k],
      [74 * k, 122 * k],
      [96 * k, 70 * k],
    ]);
    const z = polyline(x, y, [
      [112 * k, 72 * k],
      [146 * k, 72 * k],
      [112 * k, 122 * k],
      [148 * k, 122 * k],
    ]);
    return over(color, blue, cover(Math.min(v, z) - 7 * k));
  });
}

/** Quadrado colorido com um botão de reproduzir, dentro de uma margem de cor lisa. */
function framedPlate(size: number, frame: Rgba, plateColor: readonly [number, number, number]) {
  const margin = Math.round(size * 0.09);
  const plate = size - 2 * margin;
  return encodePng(size, size, (x, y) => {
    const inPlate = cover(roundedRect(x, y, margin, margin, plate, plate * 0.2));
    let color = over(frame, plateColor, inPlate);
    const disc = Math.hypot(x - size / 2, y - size / 2) - size * 0.2;
    color = over(color, [255, 255, 255], cover(disc) * inPlate);
    const inTriangle =
      x > size * 0.46 && x < size * 0.6 && Math.abs(y - size / 2) < (size * 0.6 - x) * 0.9;
    return inTriangle ? over(color, plateColor, 1) : color;
  });
}

/** Quadrado azul-petróleo com uma moldura branca de 9% em volta. */
export const whiteMarginIcon = (size = 96) =>
  framedPlate(size, [255, 255, 255, 255], [21, 105, 120]);

/** Quadrado laranja com 9% de margem transparente (sem sombra). */
export const transparentMarginIcon = (size = 96) => framedPlate(size, [0, 0, 0, 0], [226, 104, 38]);

/** Quadrado azul-marinho com uma moldura de âmbar (cor chapada, não branca) de 9%. */
export const flatMarginIcon = (size = 96) => framedPlate(size, [232, 168, 56, 255], [28, 48, 104]);

/** Placa preta de ponta a ponta com um logotipo de barras brancas e um ponto vermelho, sem margem nenhuma. */
export function blackBarsIcon(size = 192): Buffer {
  const k = size / 192;
  return encodePng(size, size, (x, y) => {
    let color: Rgba = [14, 14, 14, 255];
    const bars: [number, number][] = [
      [52, 70],
      [76, 100],
      [100, 80],
      [124, 100],
    ];
    for (const [left, height] of bars) {
      const dx = Math.abs(x - (left + 7) * k) - 1 * k;
      const dy = Math.abs(y - 96 * k) - (height / 2) * k + 6 * k;
      const distance =
        Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - 6 * k;
      color = over(color, [245, 245, 245], cover(distance));
    }
    return over(color, [214, 48, 49], cover(Math.hypot(x - 158 * k, y - 96 * k) - 12 * k));
  });
}

/** Banner 16:9 de ponta a ponta, azul-petróleo, com um logotipo no meio: o que o cache antigo ainda guarda. */
export function tealBannerIcon(width = 320, height = 180): Buffer {
  return encodePng(width, height, (x, y) => {
    const base: Rgba = [18 + (x / width) * 30, 90 + (y / height) * 40, 104, 255];
    const disc = Math.hypot(x - width / 2, y - height / 2) - height * 0.24;
    const withDisc = over(base, [255, 255, 255], cover(disc));
    return over(
      withDisc,
      [18, 90, 104],
      cover(Math.hypot(x - width / 2, y - height / 2) - height * 0.1),
    );
  });
}

/** Cada ícone sintético, com o que se espera do ajuste: `trimmed` (a margem própria é aparada) e `own` (cor própria até a borda). */
export interface FitCase {
  readonly name: string;
  readonly uri: string;
  readonly trimmed: boolean;
  readonly own: boolean;
}

export const FIT_CASES: readonly FitCase[] = [
  { name: 'CineVS', uri: toDataUri(cinevsLikeIcon()), trimmed: true, own: true },
  { name: 'Margem branca', uri: toDataUri(whiteMarginIcon()), trimmed: true, own: true },
  {
    name: 'Margem transparente',
    uri: toDataUri(transparentMarginIcon()),
    trimmed: true,
    own: true,
  },
  { name: 'Fundo preto com barras', uri: toDataUri(blackBarsIcon()), trimmed: false, own: true },
  { name: 'Banner 16 por 9', uri: toDataUri(tealBannerIcon()), trimmed: false, own: true },
  { name: 'Moldura de cor lisa', uri: toDataUri(flatMarginIcon()), trimmed: true, own: true },
  { name: 'Quadrado sem margem', uri: ICONS.square, trimmed: false, own: true },
  { name: 'Desenho solto', uri: ICONS.transparent, trimmed: false, own: false },
];
