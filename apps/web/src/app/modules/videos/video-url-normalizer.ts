import type { VideoPlatform } from './video-inbox.model';

export interface NormalizedVideoUrl {
  readonly canonical_url: string;
  readonly platform: VideoPlatform;
}

const GLOBAL_TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'mc_eid',
  'msclkid',
]);

function stripQueryParams(url: URL, paramsToRemove: Set<string>): void {
  for (const key of Array.from(url.searchParams.keys())) {
    if (paramsToRemove.has(key) || key.startsWith('utm_')) {
      url.searchParams.delete(key);
    }
  }
}

function normalizeInstagram(url: URL): NormalizedVideoUrl {
  url.protocol = 'https:';
  url.hostname = 'www.instagram.com';

  // Links de /share/ usam códigos de redirecionamento diferentes do identificador do reel.
  let pathname = url.pathname;
  if (pathname.startsWith('/reels/')) {
    pathname = '/reel/' + pathname.slice('/reels/'.length);
  }

  // Garante barra final em posts e reels do Instagram
  if (
    (pathname.startsWith('/reel/') || pathname.startsWith('/p/') || pathname.startsWith('/tv/')) &&
    !pathname.endsWith('/')
  ) {
    pathname += '/';
  }
  url.pathname = pathname;

  // Limpa parâmetros de rastreamento do Instagram
  const igTracking = new Set([
    ...GLOBAL_TRACKING_PARAMS,
    'igsh',
    'igshid',
    'img_index',
    'ndid',
    'theme',
  ]);
  stripQueryParams(url, igTracking);

  return {
    canonical_url: url.toString(),
    platform: 'instagram',
  };
}

function normalizeYouTube(url: URL): NormalizedVideoUrl {
  url.protocol = 'https:';
  const hostname = url.hostname.toLowerCase();

  // Caso 1: link encurtado youtu.be/<id>
  if (hostname === 'youtu.be') {
    const videoId = url.pathname.replace(/^\/+/, '').split('/')[0];
    const timestamp = url.searchParams.get('t') ?? url.searchParams.get('time_continue');

    const canonical = new URL('https://www.youtube.com/watch');
    if (videoId) canonical.searchParams.set('v', videoId);
    if (timestamp) canonical.searchParams.set('t', timestamp);

    return {
      canonical_url: canonical.toString(),
      platform: 'youtube',
    };
  }

  // Caso 2: shorts do YouTube (youtube.com/shorts/<id>)
  if (url.pathname.startsWith('/shorts/')) {
    const shortId = url.pathname.slice('/shorts/'.length).replace(/\/.*$/, '');
    const canonical = new URL(`https://www.youtube.com/shorts/${shortId}`);
    return {
      canonical_url: canonical.toString(),
      platform: 'youtube',
    };
  }

  // Caso 3: watch padrão do YouTube
  url.hostname = 'www.youtube.com';
  const videoId = url.searchParams.get('v');
  const timestamp = url.searchParams.get('t') ?? url.searchParams.get('time_continue');

  const ytTracking = new Set([
    ...GLOBAL_TRACKING_PARAMS,
    'si',
    'feature',
    'pp',
    'app',
    'embeds_referring_euri',
  ]);
  stripQueryParams(url, ytTracking);

  if (videoId) {
    const canonical = new URL('https://www.youtube.com/watch');
    canonical.searchParams.set('v', videoId);
    if (timestamp) canonical.searchParams.set('t', timestamp);
    return {
      canonical_url: canonical.toString(),
      platform: 'youtube',
    };
  }

  return {
    canonical_url: url.toString(),
    platform: 'youtube',
  };
}

function normalizeTikTok(url: URL): NormalizedVideoUrl {
  url.protocol = 'https:';
  if (url.hostname.toLowerCase() === 'm.tiktok.com') {
    url.hostname = 'www.tiktok.com';
  }

  const tiktokTracking = new Set([
    ...GLOBAL_TRACKING_PARAMS,
    '_t',
    '_r',
    'is_from_webapp',
    'sender_device',
    'checksum',
    'share_app_id',
    'share_link_id',
    'timestamp',
  ]);
  stripQueryParams(url, tiktokTracking);

  return {
    canonical_url: url.toString(),
    platform: 'tiktok',
  };
}

function normalizeTwitter(url: URL): NormalizedVideoUrl {
  url.protocol = 'https:';
  if (url.hostname !== 't.co') url.hostname = 'x.com';

  const twitterTracking = new Set([
    ...GLOBAL_TRACKING_PARAMS,
    's',
    't',
    'ref_src',
    'ref_url',
    'mx',
  ]);
  stripQueryParams(url, twitterTracking);

  return {
    canonical_url: url.toString(),
    platform: 'twitter',
  };
}

function normalizeOther(url: URL): NormalizedVideoUrl {
  url.hostname = url.hostname.toLowerCase();
  stripQueryParams(url, GLOBAL_TRACKING_PARAMS);

  return {
    canonical_url: url.toString(),
    platform: 'other',
  };
}

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

// Esquema no início do texto; `host:porta` (dígito após os dois-pontos) não conta como esquema.
const EXPLICIT_SCHEME = /^\s*[a-z][a-z0-9+.-]*:(?!\d)/i;

/**
 * Indica se o valor é uma URL HTTP(S) absoluta sem credenciais.
 * Única regra usada para decidir o que pode ser salvo ou virar link clicável.
 */
export function isHttpUrl(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return HTTP_PROTOCOLS.has(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Normaliza a URL extraída e identifica a plataforma (instagram, youtube, tiktok, twitter, outros).
 */
export function normalizeVideoUrl(rawUrl: string | URL): NormalizedVideoUrl {
  // Um esquema explícito diferente de http/https (javascript:, data:, blob:, file:...) nunca é
  // promovido a https: o valor volta intacto para que quem chama o rejeite com `isHttpUrl`.
  if (typeof rawUrl === 'string' && EXPLICIT_SCHEME.test(rawUrl) && !/^https?:/i.test(rawUrl)) {
    return { canonical_url: rawUrl, platform: 'other' };
  }

  let parsed: URL;
  try {
    const input =
      typeof rawUrl === 'string' && !/^https?:\/\//i.test(rawUrl) ? `https://${rawUrl}` : rawUrl;
    parsed = new URL(input);
  } catch {
    return { canonical_url: rawUrl.toString(), platform: 'other' };
  }

  if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
    return { canonical_url: rawUrl.toString(), platform: 'other' };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (
    hostname === 'instagram.com' ||
    hostname.endsWith('.instagram.com') ||
    hostname === 'instagr.am'
  ) {
    return normalizeInstagram(parsed);
  }

  if (
    hostname === 'youtube.com' ||
    hostname.endsWith('.youtube.com') ||
    hostname === 'youtu.be' ||
    hostname === 'youtube-nocookie.com' ||
    hostname.endsWith('.youtube-nocookie.com')
  ) {
    return normalizeYouTube(parsed);
  }

  if (hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com')) {
    return normalizeTikTok(parsed);
  }

  if (
    hostname === 'twitter.com' ||
    hostname.endsWith('.twitter.com') ||
    hostname === 'x.com' ||
    hostname.endsWith('.x.com') ||
    hostname === 't.co'
  ) {
    return normalizeTwitter(parsed);
  }

  return normalizeOther(parsed);
}
