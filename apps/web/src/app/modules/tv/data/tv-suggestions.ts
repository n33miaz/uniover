import type { TvShortcut } from './tv-types';
import { shortcutLabel } from './tv-types';

/**
 * Um app conhecido: serve para pôr as marcas mais usadas na frente das sugestões e para dar ao azulejo de reserva (o
 * app sem ícone) uma cor parecida com a da marca. Nenhum logotipo de terceiro entra aqui: só o nome, os pacotes e uma
 * cor de fundo com a tinta que dá contraste AA sobre ela. A sugestão em si vem SEMPRE da lista que a TV informou: um app
 * que não está instalado nunca é oferecido.
 */
export interface TvKnownApp {
  /** Identificador estável; nunca é mostrado. */
  readonly key: string;
  /** Pacotes do app (Android TV e o id do app Tizen da Samsung). */
  readonly packages: readonly string[];
  /** Fundo do azulejo de reserva, parecido com a cor da marca. */
  readonly tint: string;
  /** Tinta da letra sobre `tint` (contraste de pelo menos 4,5:1). */
  readonly ink: '#ffffff' | '#111111';
  /** O que o azulejo de reserva escreve, quando a inicial do nome não basta (ex.: "D+"). */
  readonly mark?: string;
}

/** Na ordem de preferência das sugestões: os de uso mais comum primeiro. */
export const TV_KNOWN_APPS: readonly TvKnownApp[] = [
  {
    key: 'youtube',
    packages: ['com.google.android.youtube.tv', 'samsung.app.id111299001912'],
    tint: '#cc0000',
    ink: '#ffffff',
  },
  {
    key: 'netflix',
    packages: ['com.netflix.ninja', 'samsung.app.id3201907018807'],
    tint: '#b20710',
    ink: '#ffffff',
  },
  {
    key: 'prime-video',
    packages: ['com.amazon.amazonvideo.livingroom', 'samsung.app.id3201910019365'],
    tint: '#0f6aa8',
    ink: '#ffffff',
  },
  {
    key: 'disney-plus',
    packages: ['com.disney.disneyplus', 'samsung.app.id3201901017640'],
    tint: '#113ccf',
    ink: '#ffffff',
    mark: 'D+',
  },
  {
    key: 'globoplay',
    packages: ['com.globo.globotv', 'samsung.app.id3201908019022'],
    tint: '#c4004f',
    ink: '#ffffff',
  },
  {
    key: 'max',
    packages: ['com.wbd.stream', 'samsung.app.id3202301029760', 'samsung.app.id3201601007230'],
    tint: '#002be7',
    ink: '#ffffff',
  },
  {
    key: 'spotify',
    packages: ['com.spotify.tv.android', 'samsung.app.id3201606009684'],
    tint: '#1db954',
    ink: '#111111',
  },
  {
    key: 'paramount-plus',
    packages: ['com.cbs.ott', 'samsung.app.id3201710014981'],
    tint: '#0050d8',
    ink: '#ffffff',
    mark: 'P+',
  },
  {
    key: 'apple-tv',
    packages: ['com.apple.atve.androidtv.appletv', 'samsung.app.id3201807016597'],
    tint: '#111111',
    ink: '#ffffff',
    mark: 'tv',
  },
  {
    key: 'youtube-kids',
    packages: ['com.google.android.youtube.tvkids'],
    tint: '#cc0000',
    ink: '#ffffff',
  },
  {
    key: 'youtube-music',
    packages: ['com.google.android.youtube.tvmusic'],
    tint: '#cc0000',
    ink: '#ffffff',
  },
  {
    key: 'pluto-tv',
    packages: ['tv.pluto.android', 'samsung.app.id3201808016802'],
    tint: '#2b2b2b',
    ink: '#ffffff',
  },
  {
    key: 'twitch',
    packages: ['tv.twitch.android.app', 'samsung.app.id3202203026841'],
    tint: '#772ce8',
    ink: '#ffffff',
  },
  {
    key: 'deezer',
    packages: ['deezer.android.tv', 'samsung.app.id3201608010191'],
    tint: '#8c1fe0',
    ink: '#ffffff',
  },
  {
    key: 'crunchyroll',
    packages: ['com.crunchyroll.crunchyroid'],
    tint: '#f47521',
    ink: '#111111',
  },
  { key: 'plex', packages: ['com.plexapp.android'], tint: '#e5a00d', ink: '#111111' },
  { key: 'kodi', packages: ['org.xbmc.kodi'], tint: '#17b2e7', ink: '#111111' },
  { key: 'vlc', packages: ['org.videolan.vlc'], tint: '#ff8800', ink: '#111111' },
];

const BY_PACKAGE: ReadonlyMap<string, { app: TvKnownApp; rank: number }> = new Map(
  TV_KNOWN_APPS.flatMap((app, rank) => app.packages.map((pkg) => [pkg, { app, rank }] as const)),
);

/** O app conhecido de um pacote, ou `null`. */
export function knownApp(packageName: string): TvKnownApp | null {
  return BY_PACKAGE.get(packageName)?.app ?? null;
}

/** Lugar do pacote na ordem das marcas conhecidas; os demais vêm depois de todas. */
function knownRank(packageName: string): number {
  return BY_PACKAGE.get(packageName)?.rank ?? TV_KNOWN_APPS.length;
}

/** Minúsculas, sem acento e só letras e números: "Disney+" e "disney" são o mesmo nome. */
export function plainName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

/**
 * Os apps instalados na TV, prontos para escolher: as marcas conhecidas primeiro (na ordem de `TV_KNOWN_APPS`), o
 * resto pelo nome em ordem alfabética. Desinstalados ficam de fora: não há o que abrir nem o que fixar.
 */
export function rankInstalledApps(list: readonly TvShortcut[] | null): TvShortcut[] {
  return (list ?? [])
    .filter((item) => item.installed)
    .map((item) => ({ item, rank: knownRank(item.package), name: shortcutLabel(item) }))
    .sort((a, b) => a.rank - b.rank || collator.compare(a.name, b.name))
    .map(({ item }) => item);
}

/** Largura de um azulejo da faixa de atalhos e o vão entre eles (os mesmos do CSS da faixa). */
export const SUGGESTION_TILE_PX = 60;
export const SUGGESTION_GAP_PX = 8;
/** Folga que a faixa guarda de sobra (soma das duas pontas), para as sugestões nunca encostarem nas bordas. */
export const SUGGESTION_SLACK_PX = 16;

/**
 * Quantas sugestões cabem na faixa, lado a lado e sem rolar, com folga: o que sobra da largura medida depois da folga,
 * dividido pelo azulejo mais o vão. Largura desconhecida (0, antes da primeira medida) não cabe nenhuma.
 */
export function suggestionCapacity(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  const room = width - SUGGESTION_SLACK_PX + SUGGESTION_GAP_PX;
  return Math.max(0, Math.floor(room / (SUGGESTION_TILE_PX + SUGGESTION_GAP_PX)));
}

/**
 * As sugestões à vista: apps instalados que ainda não estão no controle, sem os que a pessoa removeu (guardados pelo
 * pacote), na ordem de `rankInstalledApps` e no máximo os que cabem.
 */
export function pickSuggestions(
  list: readonly TvShortcut[] | null,
  dismissed: readonly string[],
  capacity: number,
): TvShortcut[] {
  if (capacity <= 0) return [];
  return rankInstalledApps(list)
    .filter((item) => !item.enabled && !dismissed.includes(item.package))
    .slice(0, capacity);
}

/** Filtra pela busca (nome do dono, nome da TV ou pacote), sem acento nem caixa; busca vazia devolve tudo. */
export function filterApps(list: readonly TvShortcut[], query: string): TvShortcut[] {
  const needle = plainName(query);
  if (!needle) return [...list];
  return list.filter((item) =>
    [shortcutLabel(item), item.tvLabel ?? '', item.package].some((text) =>
      plainName(text).includes(needle),
    ),
  );
}

/**
 * A ordem de TODOS os atalhos (ids) com `incoming` posto no lugar de `outgoing`, logo antes dele: a troca deixa o app
 * novo exatamente onde o antigo estava na fileira. `null` se algum dos dois não está na lista ou se são o mesmo.
 */
export function replacementOrder(
  list: readonly TvShortcut[],
  outgoing: string,
  incoming: string,
): string[] | null {
  if (outgoing === incoming) return null;
  const ids = list.map((item) => item.id);
  if (!ids.includes(outgoing) || !ids.includes(incoming)) return null;
  const rest = ids.filter((id) => id !== incoming);
  rest.splice(rest.indexOf(outgoing), 0, incoming);
  return rest;
}
