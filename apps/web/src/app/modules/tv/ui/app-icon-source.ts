import type { TvShortcut } from '../data/tv-types';

/** O que o azulejo precisa saber de um atalho; `iconDataUri` pode faltar em linhas guardadas antes dos ícones. */
export type AppIconSubject = Pick<TvShortcut, 'package' | 'position' | 'customLabel' | 'tvLabel'> &
  Partial<Pick<TvShortcut, 'iconDataUri'>>;

/** Quantas cores de reserva existem (as classes `hue-0` a `hue-5` do CSS do azulejo). */
export const FALLBACK_HUES = 6;

/** Só PNG e WebP em `data:` (o que a API entrega); qualquer outra coisa, inclusive endereço de rede, fica de fora. */
const PREFIXES = ['data:image/png;base64,', 'data:image/webp;base64,'] as const;

/** Ícones oficiais (das lojas) dos apps Tizen mais comuns. Alguns firmwares Samsung não devolvem o EDEN de ícones. */
const SAMSUNG_ICON_PATHS: Readonly<Record<string, string>> = {
  'samsung.app.id111299001912': '/tv/app-icons/youtube.png',
  'samsung.app.id3201907018807': '/tv/app-icons/netflix.png',
  'samsung.app.id3201910019365': '/tv/app-icons/prime-video.png',
  'samsung.app.id3201901017640': '/tv/app-icons/disney-plus.png',
  'samsung.app.id3201908019022': '/tv/app-icons/globoplay.png',
  'samsung.app.id3202301029760': '/tv/app-icons/max.png',
  'samsung.app.id3201601007230': '/tv/app-icons/max.png',
  'samsung.app.id3201606009684': '/tv/app-icons/spotify.png',
  'samsung.app.id3201807016597': '/tv/app-icons/apple-tv.png',
  'samsung.app.id3201808016802': '/tv/app-icons/pluto-tv.png',
  'samsung.app.id3201710014981': '/tv/app-icons/paramount-plus.png',
  'samsung.app.id3202203026841': '/tv/app-icons/twitch.png',
  'samsung.app.id3201608010191': '/tv/app-icons/deezer.png',
  'com.samsung.tv.tvPlusDeeplinker': '/tv/app-icons/samsung-tv-plus.svg',
};

/** O ícone como texto pronto para o `<img>`, ou `null` quando não há (ou não é um PNG/WebP em `data:`). */
export function iconSource(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return PREFIXES.some((prefix) => value.length > prefix.length && value.startsWith(prefix))
    ? value
    : null;
}

/** Imagem local para o alias Tizen quando a própria TV não forneceu uma imagem pelo contrato v2. */
export function samsungIconSource(packageName: string): string | null {
  return SAMSUNG_ICON_PATHS[packageName] ?? null;
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
