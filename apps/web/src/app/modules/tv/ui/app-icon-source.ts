import type { TvShortcut } from '../data/tv-types';

/** O que o azulejo precisa saber de um atalho; `iconDataUri` pode faltar em linhas guardadas antes dos ícones. */
export type AppIconSubject = Pick<TvShortcut, 'package' | 'position' | 'customLabel' | 'tvLabel'> &
  Partial<Pick<TvShortcut, 'iconDataUri'>>;

/** `square`: ícone comum. `wide`: banner (o CineVS chega como 320x180), que ganha um azulejo mais largo. */
export type IconShape = 'square' | 'wide';

/** Quantas cores de reserva existem (as classes `hue-0` a `hue-5` do CSS do azulejo). */
export const FALLBACK_HUES = 6;

/** A partir desta proporção largura/altura a imagem é tratada como banner. */
const WIDE_RATIO = 1.3;

/** Só PNG e WebP em `data:` (o que a API entrega); qualquer outra coisa, inclusive endereço de rede, fica de fora. */
const PREFIXES = ['data:image/png;base64,', 'data:image/webp;base64,'] as const;

/** O ícone como texto pronto para o `<img>`, ou `null` quando não há (ou não é um PNG/WebP em `data:`). */
export function iconSource(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return PREFIXES.some((prefix) => value.length > prefix.length && value.startsWith(prefix))
    ? value
    : null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  return [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));
}

const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32le = (b: Uint8Array, at: number) => (u24le(b, at) | (b[at + 3] << 24)) >>> 0;
const u32be = (b: Uint8Array, at: number) =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** Largura e altura lidas só do cabeçalho da imagem (nada é decodificado): PNG e os três tipos de WebP. */
export function imageSize(uri: string): { width: number; height: number } | null {
  let bytes: Uint8Array;
  try {
    // 48 caracteres de base64 são 36 bytes: o cabeçalho de todos os formatos acima cabe nisso.
    const head = atob(uri.slice(uri.indexOf(',') + 1).slice(0, 48));
    bytes = Uint8Array.from(head, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  let size: { width: number; height: number } | null = null;
  if (bytes.length >= 24 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    size = { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  } else if (bytes.length >= 30 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) {
    if (ascii(bytes, 12, 'VP8X')) {
      size = { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
    } else if (ascii(bytes, 12, 'VP8L') && bytes[20] === 0x2f) {
      const bits = u32le(bytes, 21);
      size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (ascii(bytes, 12, 'VP8 ')) {
      size = { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
    }
  }
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** Banner ou ícone comum; sem cabeçalho legível vale `square` (a imagem nunca é cortada nem esticada de todo jeito). */
export function iconShape(uri: string): IconShape {
  const size = imageSize(uri);
  return size && size.width / size.height >= WIDE_RATIO ? 'wide' : 'square';
}

/** Índice estável (0 a 5) da cor de reserva de um pacote: o mesmo app tem sempre a mesma cor. */
export function fallbackHue(packageName: string): number {
  let hash = 2166136261;
  for (let index = 0; index < packageName.length; index++) {
    hash = Math.imul(hash ^ packageName.charCodeAt(index), 16777619) >>> 0;
  }
  return hash % FALLBACK_HUES;
}

/**
 * O que o azulejo de reserva escreve: a inicial do nome que o dono ou a TV deram ao app. Sem nome (o "Atalho n"
 * padrão), ou se o nome não tem letra nem número, vale o número da posição: nunca uma letra sem sentido.
 */
export function fallbackGlyph(
  shortcut: Pick<TvShortcut, 'customLabel' | 'tvLabel' | 'position'>,
): string {
  const name = shortcut.customLabel?.trim() || shortcut.tvLabel?.trim();
  const first = name ? /[\p{L}\p{N}]/u.exec(name)?.[0] : undefined;
  return first ? first.toLocaleUpperCase('pt-BR') : String(shortcut.position);
}
