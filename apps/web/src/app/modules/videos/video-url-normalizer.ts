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

function normalizeInstagram(parsed: URL): NormalizedVideoUrl {
  const url = new URL(parsed.toString());
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

function normalizeYouTube(parsed: URL): NormalizedVideoUrl {
  const url = new URL(parsed.toString());
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

function normalizeTikTok(parsed: URL): NormalizedVideoUrl {
  const url = new URL(parsed.toString());
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

function normalizeTwitter(parsed: URL): NormalizedVideoUrl {
  const url = new URL(parsed.toString());
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

function normalizeOther(parsed: URL): NormalizedVideoUrl {
  const url = new URL(parsed.toString());
  url.hostname = url.hostname.toLowerCase();
  stripQueryParams(url, GLOBAL_TRACKING_PARAMS);

  return {
    canonical_url: url.toString(),
    platform: 'other',
  };
}

/**
 * Normaliza a URL extraída e identifica a plataforma (instagram, youtube, tiktok, twitter, outros).
 */
export function normalizeVideoUrl(rawUrl: string): NormalizedVideoUrl {
  let parsed: URL;
  try {
    const input = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    parsed = new URL(input);
  } catch {
    return { canonical_url: rawUrl, platform: 'other' };
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
