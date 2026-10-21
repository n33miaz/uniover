/**
 * Ajuste do ícone ao azulejo: acha a margem do próprio ícone (a faixa transparente, ou a moldura de uma cor chapada,
 * que alguns apps desenham em volta) e diz quanto aparar para o desenho encher o azulejo. A análise é uma função pura
 * sobre pixels RGBA, sem DOM; a leitura do canvas e o cache em memória ficam no fim do arquivo.
 *
 * Princípio: errar para o lado de não cortar. Cada borda perde no máximo `MAX_TRIM` do lado, e só se corta o que é
 * claramente margem. Um desenho solto sobre o transparente mantém uma folga própria (`FREE_FORM_KEEP`); uma placa de
 * uma cor só (o quadrado arredondado preto do CineVS) é aparada rente, e a cor dela vira o fundo do azulejo, que
 * é o que esconde os cantos transparentes da placa e qualquer fio de arredondamento.
 */

export interface IconColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Fração do lado (0 a `MAX_TRIM`) a aparar em cada borda. */
export interface EdgeTrim {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface EdgeAnalysis {
  readonly trim: EdgeTrim;
  /** A cor das bordas quando o ícone é uma placa (opaca em volta); `null` quando é um desenho solto. */
  readonly background: IconColor | null;
}

/** Quanto de cada lado pode ser aparado: o suficiente para uma margem comum, nunca o desenho. */
export const MAX_TRIM = 0.18;

/** Acima disto um pixel conta como tinta; abaixo, como transparente (a sombra suave de um ícone fica de fora). */
const SOLID_ALPHA = 128;
/** Diferença máxima por canal para duas cores valerem como a mesma (absorve o ruído da compressão). */
const COLOR_TOLERANCE = 18;
/** Numa fileira de margem, até esta fração dos pixels pode ser "sujeira" (um pixel isolado não segura o corte). */
const STRAY_SHARE = 0.02;
/** Folga que um desenho solto sobre o transparente mantém: as pontas de um logotipo não vão para o canto arredondado. */
const FREE_FORM_KEEP = 0.07;
/** O contorno do conteúdo é uma placa quando metade dele ao menos é opaca (os cantos arredondados são transparentes). */
const PLATE_OPAQUE_SHARE = 0.5;
/** Para tratar a borda como uma moldura de cor chapada, esta fração do contorno tem de ter a mesma cor. */
const FRAME_AGREE_SHARE = 0.9;
/** Aparar a moldura só vale se o que aparece depois dela não for, ele mesmo, mais moldura (fundo do ícone). */
const FRAME_EXPOSED_SHARE = 0.5;

const NO_TRIM: EdgeTrim = { left: 0, top: 0, right: 0, bottom: 0 };
const NOTHING: EdgeAnalysis = { trim: NO_TRIM, background: null };

interface Box {
  readonly x0: number;
  readonly y0: number;
  /** Exclusivos. */
  readonly x1: number;
  readonly y1: number;
}

type Rgba = ArrayLike<number>;

/** Encolhe a caixa enquanto a fileira (ou coluna) da ponta for só fundo; `null` se nada sobra. */
function shrink(box: Box, isBackground: (x: number, y: number) => boolean): Box | null {
  let { x0, y0, x1, y1 } = box;
  const rowIsBackground = (y: number) => {
    const allowed = Math.floor((x1 - x0) * STRAY_SHARE);
    let stray = 0;
    for (let x = x0; x < x1; x++) if (!isBackground(x, y) && ++stray > allowed) return false;
    return true;
  };
  const columnIsBackground = (x: number) => {
    const allowed = Math.floor((y1 - y0) * STRAY_SHARE);
    let stray = 0;
    for (let y = y0; y < y1; y++) if (!isBackground(x, y) && ++stray > allowed) return false;
    return true;
  };
  while (y0 < y1 && rowIsBackground(y0)) y0++;
  if (y0 >= y1) return null;
  while (rowIsBackground(y1 - 1)) y1--;
  while (x0 < x1 && columnIsBackground(x0)) x0++;
  if (x0 >= x1) return null;
  while (columnIsBackground(x1 - 1)) x1--;
  return { x0, y0, x1, y1 };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

const near = (rgba: Rgba, at: number, color: IconColor) =>
  Math.abs(rgba[at] - color.r) <= COLOR_TOLERANCE &&
  Math.abs(rgba[at + 1] - color.g) <= COLOR_TOLERANCE &&
  Math.abs(rgba[at + 2] - color.b) <= COLOR_TOLERANCE;

interface Ring {
  /** Parte do contorno que é tinta (opaca). */
  readonly opaqueShare: number;
  /** A cor mediana da tinta do contorno, e que parte dela concorda com essa cor. */
  readonly color: IconColor | null;
  readonly agreeShare: number;
}

/** O contorno de um pixel de espessura da caixa. */
function ringOf(rgba: Rgba, width: number, box: Box): Ring {
  const at = (x: number, y: number) => (y * width + x) * 4;
  const spots: number[] = [];
  for (let x = box.x0; x < box.x1; x++) spots.push(at(x, box.y0), at(x, box.y1 - 1));
  for (let y = box.y0 + 1; y < box.y1 - 1; y++) spots.push(at(box.x0, y), at(box.x1 - 1, y));
  const opaque = spots.filter((i) => rgba[i + 3] >= SOLID_ALPHA);
  if (spots.length === 0 || opaque.length === 0) {
    return { opaqueShare: 0, color: null, agreeShare: 0 };
  }
  const color: IconColor = {
    r: median(opaque.map((i) => rgba[i])),
    g: median(opaque.map((i) => rgba[i + 1])),
    b: median(opaque.map((i) => rgba[i + 2])),
  };
  const agreeing = opaque.filter((i) => near(rgba, i, color)).length;
  return {
    opaqueShare: opaque.length / spots.length,
    color,
    agreeShare: agreeing / opaque.length,
  };
}

/**
 * A moldura de uma cor chapada: o miolo que sobra depois de tirar as fileiras que são só dessa cor (ou transparentes).
 * `null` quando não há miolo (tudo é uma cor só) ou quando o miolo ainda é, na maior parte, a mesma cor: aí a cor não é uma
 * moldura, é o próprio fundo do ícone (o Spotify: círculo verde solto numa placa preta), e cortá-la só ampliaria o
 * desenho até as bordas.
 */
function frameInner(rgba: Rgba, width: number, box: Box, frame: IconColor): Box | null {
  const isFrame = (x: number, y: number) => {
    const at = (y * width + x) * 4;
    return rgba[at + 3] < SOLID_ALPHA || near(rgba, at, frame);
  };
  const inner = shrink(box, isFrame);
  if (!inner) return null;
  let frameLike = 0;
  let total = 0;
  const count = (x: number, y: number) => {
    total++;
    if (isFrame(x, y)) frameLike++;
  };
  for (let x = inner.x0; x < inner.x1; x++) {
    count(x, inner.y0);
    count(x, inner.y1 - 1);
  }
  for (let y = inner.y0 + 1; y < inner.y1 - 1; y++) {
    count(inner.x0, y);
    count(inner.x1 - 1, y);
  }
  return total > 0 && frameLike / total >= FRAME_EXPOSED_SHARE ? null : inner;
}

const clampTrim = (value: number) => Math.min(MAX_TRIM, Math.max(0, value));

/**
 * Procura a margem do ícone em `rgba` (largura × altura × 4 bytes) e devolve quanto aparar de cada lado e a cor das
 * bordas. Qualquer entrada que não dê para ler com segurança (tamanho pequeno demais, buffer curto) não corta nada.
 */
export function analyzeIconEdges(rgba: Rgba, width: number, height: number): EdgeAnalysis {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 4 ||
    height < 4 ||
    rgba.length < width * height * 4
  ) {
    return NOTHING;
  }
  const whole: Box = { x0: 0, y0: 0, x1: width, y1: height };

  // A caixa do que é tinta: tudo o que está fora dela é transparente.
  const content = shrink(whole, (x, y) => rgba[(y * width + x) * 4 + 3] < SOLID_ALPHA);
  if (!content) return NOTHING;
  const margins: EdgeTrim = {
    left: content.x0 / width,
    top: content.y0 / height,
    right: (width - content.x1) / width,
    bottom: (height - content.y1) / height,
  };

  const ring = ringOf(rgba, width, content);
  const plate = ring.opaqueShare >= PLATE_OPAQUE_SHARE && ring.color !== null;
  const keep = plate ? 0 : FREE_FORM_KEEP;
  let trim: EdgeTrim = {
    left: margins.left - keep,
    top: margins.top - keep,
    right: margins.right - keep,
    bottom: margins.bottom - keep,
  };

  // A moldura de cor chapada em volta de outra coisa (uma borda branca em volta de um quadrado colorido).
  if (plate && ring.agreeShare >= FRAME_AGREE_SHARE) {
    const inner = frameInner(rgba, width, content, ring.color!);
    if (inner) {
      // Um pixel a mais onde houve corte: o pixel da emenda é uma mistura da moldura com o miolo.
      const seam = (moved: boolean, size: number) => (moved ? 1 / size : 0);
      trim = {
        left: inner.x0 / width + seam(inner.x0 > content.x0, width),
        top: inner.y0 / height + seam(inner.y0 > content.y0, height),
        right: (width - inner.x1) / width + seam(inner.x1 < content.x1, width),
        bottom: (height - inner.y1) / height + seam(inner.y1 < content.y1, height),
      };
    }
  }

  const capped: EdgeTrim = {
    left: clampTrim(trim.left),
    top: clampTrim(trim.top),
    right: clampTrim(trim.right),
    bottom: clampTrim(trim.bottom),
  };

  // O fundo do azulejo é a cor da borda que sobrou, quando ela é de uma placa.
  const finalRing = ringOf(rgba, width, {
    x0: Math.round(capped.left * width),
    y0: Math.round(capped.top * height),
    x1: width - Math.round(capped.right * width),
    y1: height - Math.round(capped.bottom * height),
  });
  const background =
    finalRing.opaqueShare >= PLATE_OPAQUE_SHARE && finalRing.color ? finalRing.color : null;
  return { trim: capped, background };
}

/** O recorte como um quadrado, em frações do lado da imagem: é o que o `cover` do azulejo consegue mostrar. */
export interface IconCrop {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/**
 * O recorte vira um quadrado (o azulejo é quadrado): o lado é o maior dos dois, centrado na caixa que sobrou e
 * empurrado para dentro da imagem se passasse da borda. Nunca corta mais do que a análise mandou.
 */
export function cropSquare(trim: EdgeTrim): IconCrop {
  const width = 1 - trim.left - trim.right;
  const height = 1 - trim.top - trim.bottom;
  const size = Math.min(1, Math.max(width, height));
  const place = (start: number, length: number) =>
    Math.min(1 - size, Math.max(0, start + length / 2 - size / 2));
  return { x: place(trim.left, width), y: place(trim.top, height), size };
}

/** O que o azulejo aplica, só em CSS: um `transform` sobre a imagem (já em `cover`) e a cor de fundo. */
export interface IconFit {
  readonly crop: IconCrop;
  readonly transform: string | null;
  readonly background: string | null;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function iconFit(analysis: EdgeAnalysis): IconFit {
  const crop = cropSquare(analysis.trim);
  // Menos de meio por cento de corte não compensa mexer na imagem (e não deixa fio de reamostragem).
  const transform =
    crop.size > 0.995
      ? null
      : `scale(${round3(1 / crop.size)}) translate(${round3(-crop.x * 100)}%, ${round3(-crop.y * 100)}%)`;
  const color = analysis.background;
  return {
    crop,
    transform,
    background: color ? `rgb(${color.r} ${color.g} ${color.b})` : null,
  };
}

/** O lado do canvas de análise: pequeno de propósito, o custo é o mesmo em qualquer tamanho de ícone. */
export const ANALYSIS_SIDE = 64;

export interface IconPixels {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

/** Lê os pixels de uma imagem já carregada; `null` quando não dá (sem canvas, imagem vazia, leitura negada). */
export type IconPixelReader = (image: HTMLImageElement) => IconPixels | null;

/**
 * Desenha a imagem num canvas pequeno do mesmo recorte que o `object-fit: cover` do azulejo faz (o quadrado do meio), de
 * modo que as frações achadas valem direto para o que aparece. Uma imagem em `data:` é da mesma origem, então a leitura
 * não é bloqueada.
 */
export const readIconPixels: IconPixelReader = (image) => {
  try {
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    if (!(sourceWidth > 0 && sourceHeight > 0)) return null;
    const canvas = document.createElement('canvas');
    canvas.width = ANALYSIS_SIDE;
    canvas.height = ANALYSIS_SIDE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    const side = Math.min(sourceWidth, sourceHeight);
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      image,
      (sourceWidth - side) / 2,
      (sourceHeight - side) / 2,
      side,
      side,
      0,
      0,
      ANALYSIS_SIDE,
      ANALYSIS_SIDE,
    );
    const { data } = context.getImageData(0, 0, ANALYSIS_SIDE, ANALYSIS_SIDE);
    return { data, width: ANALYSIS_SIDE, height: ANALYSIS_SIDE };
  } catch {
    return null;
  }
};

/** O ajuste de uma imagem carregada, ou `null` quando não há como medir (o azulejo fica em `cover` simples). */
export function fitFromImage(
  image: HTMLImageElement,
  read: IconPixelReader = readIconPixels,
): IconFit | null {
  try {
    const pixels = read(image);
    return pixels ? iconFit(analyzeIconEdges(pixels.data, pixels.width, pixels.height)) : null;
  } catch {
    return null;
  }
}

/** Quantos ajustes ficam guardados: a lista de apps de uma TV cabe com folga, e o teto impede o crescimento sem fim. */
const CACHE_LIMIT = 256;
const cache = new Map<string, IconFit | null>();

/** O ajuste já medido de um ícone (`null` se a medida falhou), ou `undefined` se ainda não foi medido. */
export const cachedIconFit = (uri: string): IconFit | null | undefined => cache.get(uri);

export function rememberIconFit(uri: string, fit: IconFit | null): void {
  if (!cache.has(uri) && cache.size >= CACHE_LIMIT) {
    cache.delete(cache.keys().next().value as string);
  }
  cache.set(uri, fit);
}

/** Esvazia o cache (para os testes não vazarem um ao outro). */
export const resetIconFitCache = (): void => cache.clear();
