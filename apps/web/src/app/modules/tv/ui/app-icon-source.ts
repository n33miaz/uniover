import type { TvShortcut } from '../data/tv-types';

/** O que o azulejo precisa saber de um atalho; `iconDataUri` pode faltar em linhas guardadas antes dos ícones. */
export type AppIconSubject = Pick<TvShortcut, 'package' | 'position' | 'customLabel' | 'tvLabel'> &
  Partial<Pick<TvShortcut, 'iconDataUri'>>;

/** Quantas cores de reserva existem (as classes `hue-0` a `hue-5` do CSS do azulejo). */
export const FALLBACK_HUES = 6;

/** Só PNG e WebP em `data:` (o que a API entrega); qualquer outra coisa, inclusive endereço de rede, fica de fora. */
const PREFIXES = ['data:image/png;base64,', 'data:image/webp;base64,'] as const;

/** O ícone como texto pronto para o `<img>`, ou `null` quando não há (ou não é um PNG/WebP em `data:`). */
export function iconSource(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return PREFIXES.some((prefix) => value.length > prefix.length && value.startsWith(prefix))
    ? value
    : null;
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
